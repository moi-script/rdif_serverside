import { FilterQuery } from 'mongoose';
import { vehicleRepo } from './vehicles.repository';
import { IVehicle } from './vehicles.model';
import { ApiError } from '../../utils/ApiError';
import { getPagination, buildMeta } from '../../utils/pagination';
import { Actor, assertCanWrite } from '../../utils/authority';
import { nextSchoolYearEnd } from '../../utils/schoolYear';
import { blockedCardRepo } from '../blockedCards/blockedCards.repository';
import { personRepo } from '../persons/persons.repository';

interface ListQuery {
  page?: string;
  limit?: string;
  status?: string;
  vehicle_type?: string;
}

export const vehicleService = {
  async list(query: ListQuery) {
    const p = getPagination(query as Record<string, unknown>);
    const filter: FilterQuery<IVehicle> = {};
    if (query.status) filter.status = query.status;
    if (query.vehicle_type) filter.vehicle_type = query.vehicle_type;
    const { items, total } = await vehicleRepo.findPaginated(filter, p);
    return { items, meta: buildMeta(total, p.page, p.limit) };
  },
  async get(id: string) {
    const v = await vehicleRepo.findById(id);
    if (!v) throw new ApiError('NOT_FOUND', 'Vehicle not found');
    return v;
  },
  async create(data: Partial<IVehicle>, actor: Actor) {
    assertCanWrite(actor, 'vehicle');
    // Mirrors vehicleApplicationService.create's owner check: personRepo.findById
    // is deleted-filtered, so a deleted (or dangling) owner_person_id is refused
    // here rather than silently accepted and only discovered later at the
    // barrier, where scan.service.tap would grant the vehicle on status/expiry
    // alone and then find no owner to show on the terminal.
    const owner = await personRepo.findById(String(data.owner_person_id));
    if (!owner) throw new ApiError('NOT_FOUND', 'Vehicle owner not found');
    const existingRfid = await vehicleRepo.findByRfid(String(data.rfid_uid));
    if (existingRfid) throw new ApiError('DUPLICATE_RFID');
    // A UID belongs to a person OR a vehicle, never both. scan.service.tap
    // resolves person first, so a vehicle holding a person's UID is
    // permanently unscannable — it would be accepted here and then silently
    // never work at the barrier. This is how CAV 8832 was created.
    if (data.rfid_uid) {
      const personWithRfid = await personRepo.findByRfid(String(data.rfid_uid));
      if (personWithRfid) {
        throw new ApiError('DUPLICATE_RFID', 'That RFID is already assigned to a person');
      }
    }
    // A block enforced only at the barrier would be no block at all: a
    // retired UID could be re-registered here and would then resolve
    // normally at the gate. See scan.service.tap for the other half.
    if (await blockedCardRepo.isBlocked(String(data.rfid_uid))) throw new ApiError('CARD_BLOCKED');
    const existingPlate = await vehicleRepo.findByPlate(String(data.plate_number));
    if (existingPlate) throw new ApiError('DUPLICATE_PLATE', 'Plate already registered');
    // One ACTIVE vehicle per owner. Under single-card the owner's card is the
    // key, so two active passes give the barrier no way to know which car is
    // being driven. A person may still hold multiple vehicle rows — only one
    // may be active. scan.service.tap keeps a multiple_vehicles denial as a
    // safety net for rows that predate this rule.
    if ((data.status ?? 'active') === 'active') {
      const active = await vehicleRepo.findActiveByOwner(owner._id, new Date());
      if (active.length > 0) {
        throw new ApiError(
          'CONFLICT',
          `${owner.full_name} already has an active vehicle (${active[0].plate_number}). Deactivate it first.`
        );
      }
    }
    return vehicleRepo.create({ ...data, valid_until: data.valid_until ?? nextSchoolYearEnd() });
  },
  async update(id: string, data: Partial<IVehicle>, actor: Actor) {
    assertCanWrite(actor, 'vehicle');
    // Fail closed whenever the barrier's arming state could change: either
    // the vehicle is being activated, OR its owner is being reassigned.
    // updateVehicleSchema is createVehicleSchema.partial(), so PATCH
    // /vehicles/:id can patch owner_person_id on its own, with no status
    // field at all — on an ALREADY-active vehicle that path used to skip
    // this check entirely (status stays 'active', valid_until stays ahead),
    // reaching the exact barrier the activating-path guard was meant to
    // close, just through a different field. Deactivating, or editing an
    // already-inactive vehicle with no owner change, needs no owner check —
    // nothing at the barrier is being re-armed.
    if (data.status === 'active' || data.owner_person_id) {
      const current = await vehicleRepo.findById(id);
      if (!current) throw new ApiError('NOT_FOUND', 'Vehicle not found');
      const ownerId = data.owner_person_id ?? current.owner_person_id;
      const owner = await personRepo.findById(String(ownerId));
      if (!owner) {
        throw new ApiError('NOT_FOUND', 'Vehicle owner not found or deleted; cannot activate');
      }
      // Same one-active-vehicle rule as create, on both re-arming paths:
      // activating this vehicle, and reassigning it to an owner who already
      // has an active one. Excludes this vehicle so a no-op PATCH on an
      // already-active row does not reject itself.
      const willBeActive = data.status ? data.status === 'active' : current.status === 'active';
      if (willBeActive) {
        const active = await vehicleRepo.findActiveByOwner(owner._id, new Date());
        const others = active.filter((v) => String(v._id) !== String(current._id));
        if (others.length > 0) {
          throw new ApiError(
            'CONFLICT',
            `${owner.full_name} already has an active vehicle (${others[0].plate_number}). Deactivate it first.`
          );
        }
      }
    }
    const updated = await vehicleRepo.updateById(id, data);
    if (!updated) throw new ApiError('NOT_FOUND', 'Vehicle not found');
    return updated;
  },
  async setStatus(id: string, status: 'active' | 'inactive', actor: Actor) {
    assertCanWrite(actor, 'vehicle');
    return this.update(id, { status }, actor);
  },
};
