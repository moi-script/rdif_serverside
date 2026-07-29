import { Types } from 'mongoose';
import { occupancyRepo } from './occupancy.repository';
import { ScanLogModel } from '../scan/scan.model';
import { PersonModel } from '../persons/persons.model';
import { VehicleModel } from '../vehicles/vehicles.model';
import { ApiError } from '../../utils/ApiError';
import { getPagination, buildMeta } from '../../utils/pagination';
import { lastResetBoundary } from '../../utils/occupancyWindow';

export const occupancyService = {
  async list(query: Record<string, unknown>) {
    const p = getPagination(query);
    const { items, total } = await occupancyRepo.listInside(lastResetBoundary(new Date()), p);
    return { items, meta: buildMeta(total, p.page, p.limit) };
  },

  /**
   * Forces one entity outside. Writes an append-only scan_logs row, because the
   * cleared_by/cleared_at fields on the occupancy document are overwritten by
   * the person's very next tap — usually within minutes. Without the log row,
   * an override erases its own evidence, which is exactly the mechanism someone
   * would use to help a friend past the passback check.
   */
  async clear(id: string, actorUserId: string) {
    if (!Types.ObjectId.isValid(id)) throw new ApiError('NOT_FOUND', 'Occupancy record not found');

    const actorId = new Types.ObjectId(actorUserId);
    const doc = await occupancyRepo.clearById(id, actorId);
    if (!doc) throw new ApiError('NOT_FOUND', 'No one is currently inside under that record');

    // The state change above already committed — the person is `outside` now.
    // A lookup failure past this point must never cost the audit row, so it is
    // swallowed here and falls back to 'MANUAL' rather than propagating and
    // skipping the ScanLogModel.create below. (The create() itself is left to
    // propagate: if IT fails, the override truly has no record, which is a
    // real loss, but not one this function can paper over.)
    let rfid_uid: string;
    try {
      rfid_uid = await resolveRfid(doc.entity_type, doc.entity_id);
    } catch {
      rfid_uid = 'MANUAL';
    }

    await ScanLogModel.create({
      rfid_uid,
      entity_type: doc.entity_type,
      entity_id: doc.entity_id,
      gate_id: null, // no gate — this did not happen at a terminal
      direction: 'exit',
      access_result: 'granted',
      reason: 'manual_override',
      scan_time: new Date(),
      actor_user_id: actorId,
    });

    // Deliberately NOT an attendance time_out: unlike a real exit tap, an
    // override does not claim the person actually left, so an overridden
    // person's attendance row keeps showing no time_out.
    return { cleared: true };
  },
};

/** The audit row is far more useful with the card's UID than without it. */
async function resolveRfid(
  entity_type: 'person' | 'vehicle',
  entity_id: Types.ObjectId
): Promise<string> {
  if (entity_type === 'person') {
    const person = await PersonModel.findById(entity_id).select('rfid_uid').lean();
    return person?.rfid_uid ?? 'MANUAL';
  }
  const vehicle = await VehicleModel.findById(entity_id).select('rfid_uid').lean();
  return vehicle?.rfid_uid ?? 'MANUAL';
}
