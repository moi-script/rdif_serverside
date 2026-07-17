import { FilterQuery } from 'mongoose';
import { vehicleRepo } from './vehicles.repository';
import { IVehicle } from './vehicles.model';
import { ApiError } from '../../utils/ApiError';
import { getPagination, buildMeta } from '../../utils/pagination';

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
  async create(data: Partial<IVehicle>) {
    const existingOwner = await vehicleRepo.findByOwner(String(data.owner_person_id));
    if (existingOwner) throw new ApiError('DUPLICATE_PLATE', 'Owner already has a vehicle');
    const existingRfid = await vehicleRepo.findByRfid(String(data.rfid_uid));
    if (existingRfid) throw new ApiError('DUPLICATE_RFID');
    return vehicleRepo.create(data);
  },
  async update(id: string, data: Partial<IVehicle>) {
    const updated = await vehicleRepo.updateById(id, data);
    if (!updated) throw new ApiError('NOT_FOUND', 'Vehicle not found');
    return updated;
  },
  async setStatus(id: string, status: 'active' | 'inactive') {
    return this.update(id, { status });
  },
};
