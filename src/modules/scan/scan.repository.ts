import { FilterQuery } from 'mongoose';
import { ScanLogModel, IScanLog } from './scan.model';
import { PaginationParams } from '../../utils/pagination';

export const scanRepo = {
  createLog: (data: Partial<IScanLog>) => ScanLogModel.create(data),

  async findLogsPaginated(filter: FilterQuery<IScanLog>, p: PaginationParams) {
    const [items, total] = await Promise.all([
      ScanLogModel.find(filter).sort({ scan_time: -1 }).skip(p.skip).limit(p.limit).lean(),
      ScanLogModel.countDocuments(filter),
    ]);
    return { items, total };
  },
};
