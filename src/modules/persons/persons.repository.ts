import { FilterQuery } from 'mongoose';
import { PersonModel, IPerson } from './persons.model';
import { PaginationParams } from '../../utils/pagination';

export const personRepo = {
  create: (data: Partial<IPerson>) => PersonModel.create(data),

  async findPaginated(filter: FilterQuery<IPerson>, p: PaginationParams) {
    const [items, total] = await Promise.all([
      PersonModel.find(filter).sort({ createdAt: -1 }).skip(p.skip).limit(p.limit).lean(),
      PersonModel.countDocuments(filter),
    ]);
    return { items, total };
  },

  async distinctSections(type?: string): Promise<string[]> {
    const filter: FilterQuery<IPerson> = {};
    if (type) filter.type = type;
    const values = (await PersonModel.distinct('department_section', filter)) as (string | null)[];
    return values.filter((v): v is string => Boolean(v)).sort();
  },

  findById: (id: string) => PersonModel.findById(id).lean(),
  findByRfid: (rfid_uid: string) => PersonModel.findOne({ rfid_uid }),
  updateById: (id: string, data: Partial<IPerson>) =>
    PersonModel.findByIdAndUpdate(id, data, { new: true }).lean(),
};
