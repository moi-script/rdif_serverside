import { FilterQuery } from 'mongoose';
import { vehicleRepo } from './vehicles.repository';
import { IVehicle } from './vehicles.model';
import { ApiError } from '../../utils/ApiError';
import { getPagination, buildMeta } from '../../utils/pagination';
import { Actor, assertCanWrite } from '../../utils/authority';
import { nextSchoolYearEnd } from '../../utils/schoolYear';
import { blockedCardRepo } from '../blockedCards/blockedCards.repository';

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
    const existingRfid = await vehicleRepo.findByRfid(String(data.rfid_uid));
    if (existingRfid) throw new ApiError('DUPLICATE_RFID');
    // A block enforced only at the barrier would be no block at all: a
    // retired UID could be re-registered here and would then resolve
    // normally at the gate. See scan.service.tap for the other half.
    if (await blockedCardRepo.isBlocked(String(data.rfid_uid))) throw new ApiError('CARD_BLOCKED');
    const existingPlate = await vehicleRepo.findByPlate(String(data.plate_number));
    if (existingPlate) throw new ApiError('DUPLICATE_PLATE', 'Plate already registered');
    return vehicleRepo.create({ ...data, valid_until: data.valid_until ?? nextSchoolYearEnd() });
  },
  async update(id: string, data: Partial<IVehicle>, actor: Actor) {
    assertCanWrite(actor, 'vehicle');
    const updated = await vehicleRepo.updateById(id, data);
    if (!updated) throw new ApiError('NOT_FOUND', 'Vehicle not found');
    return updated;
  },
  async setStatus(id: string, status: 'active' | 'inactive', actor: Actor) {
    assertCanWrite(actor, 'vehicle');
    return this.update(id, { status }, actor);
  },
};
