import { FilterQuery } from 'mongoose';
import { VehicleModel, IVehicle } from './vehicles.model';
import { PaginationParams } from '../../utils/pagination';

export const vehicleRepo = {
  create: (data: Partial<IVehicle>) => VehicleModel.create(data),
  async findPaginated(filter: FilterQuery<IVehicle>, p: PaginationParams) {
    const [items, total] = await Promise.all([
      VehicleModel.find(filter).sort({ createdAt: -1 }).skip(p.skip).limit(p.limit).lean(),
      VehicleModel.countDocuments(filter),
    ]);
    return { items, total };
  },
  findById: (id: string) => VehicleModel.findById(id).lean(),
  findByOwner: (owner_person_id: string) => VehicleModel.findOne({ owner_person_id }),
  findByRfid: (rfid_uid: string) => VehicleModel.findOne({ rfid_uid }),
  updateById: (id: string, data: Partial<IVehicle>) =>
    VehicleModel.findByIdAndUpdate(id, data, { new: true }).lean(),
};
