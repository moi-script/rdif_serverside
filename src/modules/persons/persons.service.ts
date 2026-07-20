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

  async exportCsv(query: ListQuery): Promise<string> {
    const filter: FilterQuery<IPerson> = {};
    if (query.type) filter.type = query.type;
    if (query.status) filter.status = query.status;
    if (query.section) filter.department_section = query.section;
    if (query.search) {
      const rx = { $regex: query.search, $options: 'i' };
      filter.$or = [{ full_name: rx }, { id_number: rx }];
    }
    const rows = await personRepo.findAll(filter);
    const header =
      'full_name,type,id_number,department_section,contact_email,photo_url,rfid_uid';
    const esc = (v: unknown) => {
      const s = v == null ? '' : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = rows.map((r) =>
      [
        r.full_name,
        r.type,
        r.id_number,
        r.department_section,
        r.contact_email,
        r.photo_url,
        r.rfid_uid,
      ]
        .map(esc)
        .join(',')
    );
    return [header, ...lines].join('\n');
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

  async import(rows: Partial<IPerson>[]) {
    const skipped: { row: number; reason: string }[] = [];
    let created = 0;
    for (let i = 0; i < rows.length; i++) {
      try {
        await this.create(rows[i]);
        created++;
      } catch (err) {
        const reason =
          err instanceof ApiError && err.code === 'DUPLICATE_RFID'
            ? 'rfid_uid already registered'
            : (err as { code?: number }).code === 11000
              ? 'duplicate key (id_number or rfid_uid)'
              : (err as Error).message;
        skipped.push({ row: i + 1, reason });
      }
    }
    return { created, skipped };
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
