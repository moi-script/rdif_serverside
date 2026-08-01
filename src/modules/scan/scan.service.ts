import { Types } from 'mongoose';
import { scanRepo } from './scan.repository';
import { ScanLogModel } from './scan.model';
import { attendanceRepo } from '../attendance/attendance.repository';
import { personRepo } from '../persons/persons.repository';
import { vehicleRepo } from '../vehicles/vehicles.repository';
import { gateRepo } from '../gates/gates.repository';
import { blockedCardRepo } from '../blockedCards/blockedCards.repository';
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
  person?: {
    full_name: string;
    type: string;
    owner_type?: string;
    department_section: string | null;
    photo_url?: string;
    plate_number?: string;
    vehicle?: { vehicle_type: string; make?: string };
    registered?: { vehicle_type: string; make?: string }[];
  };
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

    let entity_type: 'person' | 'vehicle' = 'person';
    let entity_id: Types.ObjectId | null = null;
    let access_result: 'granted' | 'denied' = 'denied';
    let reason: string | null = 'unregistered_uid';
    let personView: TapResult['person'];
    // Set ONLY on a granted owner-card resolution: the person whose card
    // opened a vehicle gate. Drives the companion occupancy and attendance
    // writes in Task 2. Null on every other path, including vehicle-tag taps
    // — a sticker identifies a car, a card identifies a person, and only the
    // latter is evidence that the human was present.
    let companionPersonId: Types.ObjectId | null = null;

    // A blocked card is refused before we look up what it used to be. It is
    // checked first because a blocked UID must never resolve to an identity:
    // the card may be in the wrong hands, which is why it was retired.
    //
    // Like every denial, this sits before the anti-passback block, so a blocked
    // card can never move anyone's inside/outside state.
    if (await blockedCardRepo.isBlocked(input.rfid_uid)) {
      access_result = 'denied';
      reason = 'card_blocked';
      // personView is deliberately left undefined.
    } else {
      // Resolve entity by RFID: person first, then vehicle
      const person = await personRepo.findByRfid(input.rfid_uid);
      if (person) {
        // Identity view shared by every person-resolved outcome below. The
        // granted owner-card path REPLACES it with the vehicle-shaped view.
        personView = {
          full_name: person.full_name,
          type: person.type,
          department_section: person.department_section ?? null,
          photo_url: person.photo_url,
        };

        if (gate.type === 'vehicle') {
          // Single-card access. The card IS correct for this gate, so the
          // denials here are about the holder's registration, never
          // wrong_gate_type. Entity stays 'person' on a denial so the scan
          // log records who was refused; only a grant becomes the vehicle.
          entity_type = 'person';
          entity_id = person._id;
          if (person.status !== 'active') {
            // Ordered BEFORE the vehicle lookup on purpose: a deactivated ID
            // is an identity problem, and reporting "no vehicle registered"
            // for it would send a guard after the wrong thing.
            access_result = 'denied';
            reason = 'inactive_id';
          } else {
            const owned = await vehicleRepo.findActiveByOwner(person._id, scan_time);
            if (owned.length === 0) {
              access_result = 'denied';
              reason = 'no_vehicle_registered';
            } else if (owned.length > 1) {
              // Registration enforces one active vehicle per owner, so this
              // is a safety net for rows that predate that rule. Refusing to
              // guess is the point: granting here would log a plate nobody
              // verified into the scan log, the occupancy roster and the
              // anomaly report.
              access_result = 'denied';
              reason = 'multiple_vehicles';
            } else {
              const v = owned[0];
              entity_type = 'vehicle';
              entity_id = v._id;
              companionPersonId = person._id;
              access_result = 'granted';
              reason = null;
              personView = {
                full_name: person.full_name,
                type: 'vehicle',
                owner_type: person.type,
                department_section: person.department_section ?? null,
                photo_url: person.photo_url,
                plate_number: v.plate_number,
                vehicle: { vehicle_type: v.vehicle_type, make: v.make },
              };
            }
          }
        } else {
          entity_type = 'person';
          entity_id = person._id;
          if (person.status === 'active') {
            access_result = 'granted';
            reason = null;
          } else {
            access_result = 'denied';
            reason = 'inactive_id';
          }
        }
      } else {
        const vehicle = await vehicleRepo.findByRfid(input.rfid_uid);
        if (vehicle) {
          entity_type = 'vehicle';
          entity_id = vehicle._id;
          if (vehicle.status !== 'active') {
            access_result = 'denied';
            reason = 'inactive_id';
          } else if (!vehicle.valid_until || vehicle.valid_until.getTime() < scan_time.getTime()) {
            // Expiry is stored as end-of-day local (see nextSchoolYearEnd), so a
            // pass valid until 2027-03-31 works for all of that day.
            //
            // `valid_until` is `required: true` on the schema, but that is
            // enforced only on write — a Vehicle row created before this field
            // existed (or restored from an older backup, or edited directly in
            // Mongo) can still have it missing. Treat a missing expiry as
            // already-expired rather than dereferencing `.getTime()` on
            // `undefined`: the latter is a raw TypeError thrown before
            // scanRepo.createLog runs below, which denies the tap AND leaves no
            // scan log, no anomaly row, nothing an auditor could find. Failing
            // closed here keeps the same fail-closed posture as the rest of
            // this function while still logging the denial.
            access_result = 'denied';
            reason = 'vehicle_expired';
          } else {
            access_result = 'granted';
            reason = null;
          }
          const owner = await personRepo.findById(String(vehicle.owner_person_id));
          personView = {
            full_name: owner?.full_name ?? 'Unknown owner',
            type: 'vehicle',
            owner_type: owner?.type,
            department_section: owner?.department_section ?? null,
            plate_number: vehicle.plate_number,
            vehicle: { vehicle_type: vehicle.vehicle_type, make: vehicle.make },
          };
        }
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
        } else if (companionPersonId) {
          // BEST-EFFORT, and deliberately second. The vehicle row above is
          // authoritative and is what the anti-passback check runs on. There
          // is no transaction here (standalone Mongo), so these two writes
          // cannot be atomic — and denying on a failure would be worse than
          // tolerating one, because the deny happens AFTER the vehicle row
          // already moved: it would record a car inside the lot while
          // keeping the barrier shut, and unwinding needs a compensating
          // release that can itself fail. Worst case here is a car correctly
          // in the lot whose driver's attendance is missing, which this log
          // line surfaces.
          //
          // 'already_inside' is benign, not an error: the person may have
          // walked in through a person gate earlier.
          try {
            await occupancyRepo.enter('person', companionPersonId, gateOid, boundary);
          } catch (err) {
            console.error(
              `[scan] companion person occupancy failed on entry for ${companionPersonId.toString()}; ` +
                'vehicle admitted anyway (best-effort)',
              err
            );
          }
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
        if (companionPersonId) {
          // Best-effort, same reasoning as entry. A person already outside is
          // SILENT rather than an anomaly: they may have walked out through a
          // person gate and returned on foot. The vehicle release above
          // carries the anomaly signal for this tap.
          try {
            await occupancyRepo.release('person', companionPersonId, gateOid, boundary);
          } catch (err) {
            console.error(
              `[scan] companion person release failed on exit for ${companionPersonId.toString()}; ` +
                'granting anyway (fail-open)',
              err
            );
          }
        }
      }
    }

    // Registered items are withheld on EVERY denial. A guard resolving a denial
    // needs to know who, not what that person owns, and a denied tap is the case
    // most likely to involve someone holding a card that is not theirs. This is
    // enforced here rather than by the UI declining to render it: a field the
    // server sends is a field that exists in the response, whoever is looking.
    //
    // Placed after wrong_gate_type (which clears personView entirely) and after
    // the anti-passback block, so it can never resurrect identity on a denial
    // that deliberately withheld it, nor attach on an already_inside denial.
    if (access_result === 'granted' && entity_type === 'person' && entity_id && personView) {
      const owned = await vehicleRepo.findActiveByOwner(entity_id, scan_time);
      personView.registered = owned.map((v) => ({ vehicle_type: v.vehicle_type, make: v.make }));
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

    // The person this tap is attributable to: the cardholder on a person tap,
    // or the owner whose card opened a vehicle gate. A vehicle TAG tap has
    // neither and correctly writes no attendance.
    const attendancePersonId = entity_type === 'person' ? entity_id : companionPersonId;
    if (access_result === 'granted' && attendancePersonId) {
      const key = dateKey(scan_time);
      if (input.direction === 'entry') {
        await attendanceRepo.upsertTimeIn(
          String(attendancePersonId),
          key,
          scan_time,
          isLate(scan_time) ? 'late' : 'present'
        );
      } else {
        await attendanceRepo.upsertTimeOut(String(attendancePersonId), key, scan_time);
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
