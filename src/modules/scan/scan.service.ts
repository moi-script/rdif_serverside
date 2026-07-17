import { Types } from 'mongoose';
import { scanRepo } from './scan.repository';
import { attendanceRepo } from '../attendance/attendance.repository';
import { PersonModel } from '../persons/persons.model';
import { VehicleModel } from '../vehicles/vehicles.model';
import { GateModel } from '../gates/gates.model';
import { ApiError } from '../../utils/ApiError';
import { env } from '../../config/env';

interface TapInput {
  rfid_uid: string;
  gate_id: string;
  direction: 'entry' | 'exit';
}

interface TapResult {
  access_result: 'granted' | 'denied';
  reason: string | null;
  scan_time: Date;
  person?: { full_name: string; type: string; photo_url?: string };
}

function dateKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function isLate(when: Date): boolean {
  const [h, m] = env.LATE_CUTOFF_TIME.split(':').map((n) => parseInt(n, 10));
  const cutoff = new Date(when);
  cutoff.setHours(h, m, 0, 0);
  return when.getTime() > cutoff.getTime();
}

export const scanService = {
  async tap(input: TapInput): Promise<TapResult> {
    const gate = await GateModel.findById(input.gate_id).lean();
    if (!gate) throw new ApiError('NOT_FOUND', 'Gate not found');

    const scan_time = new Date();

    // Resolve entity by RFID: person first, then vehicle
    const person = await PersonModel.findOne({ rfid_uid: input.rfid_uid }).lean();
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
        personView = { full_name: person.full_name, type: person.type, photo_url: person.photo_url };
      } else {
        access_result = 'denied';
        reason = 'inactive_id';
      }
    } else {
      const vehicle = await VehicleModel.findOne({ rfid_uid: input.rfid_uid }).lean();
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
      }
    }

    await scanRepo.createLog({
      rfid_uid: input.rfid_uid,
      entity_type,
      entity_id,
      gate_id: new Types.ObjectId(input.gate_id),
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
    const filter: Record<string, unknown> = {};
    if (query.gate_id) filter.gate_id = query.gate_id;
    if (query.direction) filter.direction = query.direction;
    if (query.from || query.to) {
      const range: Record<string, Date> = {};
      if (query.from) range.$gte = new Date(query.from);
      if (query.to) range.$lte = new Date(query.to);
      filter.scan_time = range;
    }
    const { items, total } = await scanRepo.findLogsPaginated(filter, p);
    return { items, meta: buildMeta(total, p.page, p.limit) };
  },
};
