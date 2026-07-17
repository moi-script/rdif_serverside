import { FilterQuery } from 'mongoose';
import { personRepo } from './persons.repository';
import { IPerson } from './persons.model';
import { ApiError } from '../../utils/ApiError';
import { getPagination, buildMeta } from '../../utils/pagination';

interface ListQuery {
  page?: string;
  limit?: string;
  type?: string;
  status?: string;
  search?: string;
}

export const personService = {
  async list(query: ListQuery) {
    const p = getPagination(query as Record<string, unknown>);
    const filter: FilterQuery<IPerson> = {};
    if (query.type) filter.type = query.type;
    if (query.status) filter.status = query.status;
    if (query.search) filter.full_name = { $regex: query.search, $options: 'i' };
    const { items, total } = await personRepo.findPaginated(filter, p);
    return { items, meta: buildMeta(total, p.page, p.limit) };
  },

  async get(id: string) {
    const person = await personRepo.findById(id);
    if (!person) throw new ApiError('NOT_FOUND', 'Person not found');
    return person;
  },

  async create(data: Partial<IPerson>) {
    const existing = await personRepo.findByRfid(data.rfid_uid as string);
    if (existing) throw new ApiError('DUPLICATE_RFID');
    return personRepo.create(data);
  },

  async update(id: string, data: Partial<IPerson>) {
    const updated = await personRepo.updateById(id, data);
    if (!updated) throw new ApiError('NOT_FOUND', 'Person not found');
    return updated;
  },

  async setStatus(id: string, status: 'active' | 'inactive') {
    return this.update(id, { status });
  },

  async reassignRfid(id: string, rfid_uid: string) {
    const clash = await personRepo.findByRfid(rfid_uid);
    if (clash && String(clash._id) !== id) throw new ApiError('DUPLICATE_RFID');
    return this.update(id, { rfid_uid });
  },
};
