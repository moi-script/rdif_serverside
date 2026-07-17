import { FilterQuery } from 'mongoose';
import { UserModel, IUser } from './users.model';
import { PaginationParams } from '../../utils/pagination';

const SAFE_FIELDS = '-password_hash -refreshTokenHash';

export const userRepo = {
  create: (data: Partial<IUser>) => UserModel.create(data),
  findByUsername: (username: string) => UserModel.findOne({ username }),
  findById: (id: string) => UserModel.findById(id),
  async findPaginated(filter: FilterQuery<IUser>, p: PaginationParams) {
    const [items, total] = await Promise.all([
      UserModel.find(filter).select(SAFE_FIELDS).sort({ createdAt: -1 }).skip(p.skip).limit(p.limit).lean(),
      UserModel.countDocuments(filter),
    ]);
    return { items, total };
  },
  updateById: (id: string, data: Partial<IUser>) =>
    UserModel.findByIdAndUpdate(id, data, { new: true }).select(SAFE_FIELDS).lean(),
};
