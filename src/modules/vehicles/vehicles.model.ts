import { Schema, model, Document, Types } from 'mongoose';

export interface IVehicle extends Document {
  _id: Types.ObjectId;
  owner_person_id: Types.ObjectId;
  plate_number: string;
  rfid_uid: string;
  vehicle_type: string;
  vehicle_model: string;
  photo_url?: string;
  status: 'active' | 'inactive';
  createdAt: Date;
}

const vehicleSchema = new Schema<IVehicle>(
  {
    owner_person_id: { type: Schema.Types.ObjectId, ref: 'Person', required: true, unique: true },
    plate_number: { type: String, required: true, unique: true },
    rfid_uid: { type: String, required: true, unique: true },
    vehicle_type: { type: String, required: true },
    vehicle_model: { type: String },
    photo_url: { type: String },
    status: { type: String, enum: ['active', 'inactive'], default: 'active' },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

export const VehicleModel = model<IVehicle>('Vehicle', vehicleSchema);
