import { Schema, model, Document, Types } from 'mongoose';

export interface IGate extends Document {
  _id: Types.ObjectId;
  name: string;
  type: 'person' | 'vehicle';
  location: string;
}

const gateSchema = new Schema<IGate>({
  name: { type: String, required: true, unique: true },
  type: { type: String, enum: ['person', 'vehicle'], required: true },
  location: { type: String },
});

export const GateModel = model<IGate>('Gate', gateSchema);
