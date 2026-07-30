import { Types } from 'mongoose';
import { scanRepo } from './scan.repository';
import { ScanLogModel } from './scan.model';
import { attendanceRepo } from '../attendance/attendance.repository';
import { personRepo } from '../persons/persons.repository';
import { vehicleRepo } from '../vehicles/vehicles.repository';
import { gateRepo } from '../gates/gates.repository';
import { ApiError } from '../../utils/ApiError';
import { env } from '../../config/env';
import { occupancyRepo } from '../occupancy/occupancy.repository';
import { lastResetBoundary } from '../../utils/occupancyWindow';
import { parseLocalDateRange } from '../../utils/dateRange';

interface TapInput {
  rfid_uid: string;
  gate_id: string;
  direction: 'entry' | 'exit';
}

interface TapResult {
  access_result: 'granted' | 'denied';
  reason: string | null;
  scan_time: Date;
  person?: { full_name: string; type: string; photo_url?: string; plate_number?: string };
}

function dateKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function isLate(when: Date): boolean {
  const [h, m] = env.LATE_CUTOFF_TIME.split(':').map((n) => parseInt(n, 10));
  const cutoff = new Date(when);
  cutoff.setHours(h, m, 0, 0);
  return when.getTime() > cutoff.getTime();
}

export const scanService = {
  async tap(input: TapInput): Promise<TapResult> {
    const gate = await gateRepo.findById(input.gate_id);
    if (!gate) throw new ApiError('NOT_FOUND', 'Gate not found');

    const scan_time = new Date();

    // Resolve entity by RFID: person first, then vehicle
    const person = await personRepo.findByRfid(input.rfid_uid);
    let entity_type: 'person' | 'vehicle' = 'person';
    let entity_id: Types.ObjectId | null = null;
    let access_result: 'granted' | 'denied' = 'denied';
    let reason: string | null = 'unregistered_uid';
    let personView: TapResult['person'];

    if (person) {
      entity_type = 'person';
      entity_id = person._id;
      if (person.status === 'active') {
        access_result = 'granted';
        reason = null;
      } else {
        access_result = 'denied';
        reason = 'inactive_id';
      }
      // Identity is shown for a grant AND for an inactive-ID denial, so a guard
      // can tell "deactivated student" from "unregistered stranger". The
      // wrong_gate_type check below clears this for the one denial that must
      // not leak who the cardholder is.
      personView = { full_name: person.full_name, type: person.type, photo_url: person.photo_url };
    } else {
      const vehicle = await vehicleRepo.findByRfid(input.rfid_uid);
      if (vehicle) {
        entity_type = 'vehicle';
        entity_id = vehicle._id;
        if (vehicle.status === 'active') {
          access_result = 'granted';
          reason = null;
        } else {
          access_result = 'denied';
          reason = 'inactive_id';
        }
        const owner = await personRepo.findById(String(vehicle.owner_person_id));
        personView = {
          full_name: owner?.full_name ?? 'Unknown owner',
          type: 'vehicle',
          plate_number: vehicle.plate_number,
        };
      }
    }

    // A gate has a fixed type now, so a person card must not open the parking
    // barrier and a vehicle tag must not register attendance at a walking gate.
    // Gadgets (Subsystem B) are deliberately exempt when they are added: the
    // check applies only to person and vehicle entities.
    if (access_result === 'granted' && entity_type !== gate.type) {
      access_result = 'denied';
      reason = 'wrong_gate_type';
      personView = undefined;
    }

    // Anti-passback. Runs only on taps that are otherwise granted, so a denied
    // card can never move anyone's state — including a stranger repeatedly
    // tapping a stolen inactive card.
    if (access_result === 'granted' && entity_id) {
      // gate._id is the same ObjectId as input.gate_id: gateRepo.findById above
      // resolved it from this exact string, so reuse it instead of
      // reconstructing a third ObjectId from the same source string.
      const gateOid = gate._id;
      // Shared by both branches so entry and exit agree on exactly the same
      // reset boundary for this tap, rather than each computing it separately.
      const boundary = lastResetBoundary(scan_time);
      if (input.direction === 'entry') {
        const outcome = await occupancyRepo.enter(entity_type, entity_id, gateOid, boundary);
        if (outcome === 'already_inside') {
          access_result = 'denied';
          reason = 'already_inside';
          // personView is deliberately KEPT: a guard needs to see who the
          // system thinks is inside in order to resolve it.
        }
      } else {
        // Egress is never blocked, including when occupancy itself is
        // unavailable: a stuck exit gate is a physical safety problem, while a
        // failed release only leaves a stale roster row that the nightly
        // boundary clears. Entry deliberately still fails closed.
        let outcome: 'released' | 'exit_without_entry';
        try {
          outcome = await occupancyRepo.release(entity_type, entity_id, gateOid, boundary);
        } catch (err) {
          console.error(
            `[scan] occupancy unavailable on exit for ${entity_type} ${entity_id.toString()}; ` +
              'granting access anyway (fail-open)',
            err
          );
          reason = 'occupancy_unavailable';
          outcome = 'released';
        }
        if (outcome === 'exit_without_entry') {
          reason = 'exit_without_entry';
        }
      }
    }

    await scanRepo.createLog({
      rfid_uid: input.rfid_uid,
      entity_type,
      entity_id,
      gate_id: gate._id,
      direction: input.direction,
      access_result,
      reason,
      scan_time,
    });

    // Attendance rollup only for granted person taps
    if (access_result === 'granted' && entity_type === 'person' && entity_id) {
      const key = dateKey(scan_time);
      if (input.direction === 'entry') {
        await attendanceRepo.upsertTimeIn(
          String(entity_id),
          key,
          scan_time,
          isLate(scan_time) ? 'late' : 'present'
        );
      } else {
        await attendanceRepo.upsertTimeOut(String(entity_id), key, scan_time);
      }
    }

    return { access_result, reason, scan_time, person: personView };
  },

  async listLogs(query: Record<string, string | undefined>) {
    const { getPagination, buildMeta } = await import('../../utils/pagination');
    const p = getPagination(query);

    const match: Record<string, unknown> = {};
    if (query.gate_id) {
      // Mongoose does NOT cast $match in an aggregation pipeline, so a raw
      // string here would compare against ObjectIds and match nothing —
      // silently returning an empty page instead of an error. Validate and
      // convert, and reject a malformed id with 422 rather than letting a BSON
      // error surface as a 500 with an internal message.
      if (!Types.ObjectId.isValid(query.gate_id)) {
        throw new ApiError('VALIDATION_ERROR', 'gate_id is not a valid id');
      }
      match.gate_id = new Types.ObjectId(query.gate_id);
    }
    if (query.direction) match.direction = query.direction;
    if (query.access_result) match.access_result = query.access_result;
    if (query.from || query.to) {
      // Callers pass local-time boundaries. Never derive these with
      // toISOString() or a bare `new Date(str)`: the server buckets
      // attendance and the occupancy reset boundary by LOCAL Date
      // components, and a UTC-parsed day queries the wrong bucket for part
      // of every day outside UTC+0. parseLocalDateRange also makes `to`
      // an EXCLUSIVE next-day boundary so the selected day is fully
      // included, not cut off at its own midnight.
      match.scan_time = parseLocalDateRange(query.from, query.to);
    }

    const pipeline = [
      { $match: match },
      { $sort: { scan_time: -1 as const } },
      { $skip: p.skip },
      { $limit: p.limit },
      { $lookup: { from: 'people', localField: 'entity_id', foreignField: '_id', as: 'person' } },
      { $lookup: { from: 'vehicles', localField: 'entity_id', foreignField: '_id', as: 'vehicle' } },
      { $lookup: { from: 'gates', localField: 'gate_id', foreignField: '_id', as: 'gateDoc' } },
      {
        // Projection is a whitelist and the joined arrays are never projected
        // themselves, so no field from a joined collection can leak.
        $project: {
          _id: 0,
          id: { $toString: '$_id' },
          scan_time: 1,
          direction: 1,
          access_result: 1,
          reason: 1,
          entity_type: 1,
          rfid_uid: 1,
          gate: {
            $cond: [
              { $gt: [{ $size: '$gateDoc' }, 0] },
              {
                id: { $toString: { $first: '$gateDoc._id' } },
                name: { $first: '$gateDoc.name' },
              },
              // null on manual occupancy overrides, which write gate_id: null.
              null,
            ],
          },
          subject: {
            $cond: [
              { $gt: [{ $size: '$person' }, 0] },
              {
                full_name: { $first: '$person.full_name' },
                id_number: { $first: '$person.id_number' },
              },
              {
                $cond: [
                  { $gt: [{ $size: '$vehicle' }, 0] },
                  { plate_number: { $first: '$vehicle.plate_number' } },
                  // null when the UID matched nothing — an unregistered card
                  // has no entity to resolve.
                  null,
                ],
              },
            ],
          },
        },
      },
    ];

    const [items, total] = await Promise.all([
      ScanLogModel.aggregate(pipeline),
      ScanLogModel.countDocuments(match),
    ]);

    // truncated sits beside buildMeta()'s pagination rather than replacing
    // it, so this endpoint's meta shape stays consistent with every other
    // list endpoint (/api/users, /api/persons, ...). It's added because a
    // silently truncated list is indistinguishable from a short one: without
    // it a caller can't tell "these are all the rows" from "there's a next
    // page".
    return {
      items,
      meta: { ...buildMeta(total, p.page, p.limit), truncated: total > p.limit },
    };
  },
};
