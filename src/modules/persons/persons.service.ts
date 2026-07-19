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
  section?: string;
  search?: string;
}

export const personService = {
  async list(query: ListQuery) {
    const p = getPagination(query as Record<string, unknown>);
    const filter: FilterQuery<IPerson> = {};
    if (query.type) filter.type = query.type;
    if (query.status) filter.status = query.status;
    if (query.section) filter.department_section = query.section;
    if (query.search) {
      const rx = { $regex: query.search, $options: 'i' };
      filter.$or = [{ full_name: rx }, { id_number: rx }];
    }
    const { items, total } = await personRepo.findPaginated(filter, p);
    return { items, meta: buildMeta(total, p.page, p.limit) };
  },

  async sections(type?: string) {
    return personRepo.distinctSections(type);
  },

  async get(id: string) {
    const person = await personRepo.findById(id);
    if (!person) throw new ApiError('NOT_FOUND', 'Person not found');
    return person;
  },

  async create(data: Partial<IPerson>) {
    if (data.rfid_uid) {
      const existing = await personRepo.findByRfid(data.rfid_uid);
      if (existing) throw new ApiError('DUPLICATE_RFID');
    } else {
      data.status = data.status ?? 'pending';
    }
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
