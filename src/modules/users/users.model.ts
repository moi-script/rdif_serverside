import { Schema, model, Document, Types } from 'mongoose';
import { ROLES, Role } from '../../constants/roles';

export interface IUser extends Document {
  _id: Types.ObjectId;
  username: string;
  password_hash: string;
  role: Role;
  person_id: Types.ObjectId | null;
  must_change_password: boolean;
  is_active: boolean;
  refreshTokenHash: string | null;
  createdAt: Date;
}

const userSchema = new Schema<IUser>(
  {
    username: { type: String, required: true, unique: true },
    password_hash: { type: String, required: true },
    role: { type: String, enum: [ROLES.ADMIN, ROLES.USER], required: true },
    person_id: { type: Schema.Types.ObjectId, ref: 'Person', default: null },
    must_change_password: { type: Boolean, default: false },
    is_active: { type: Boolean, default: true },
    refreshTokenHash: { type: String, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

export const UserModel = model<IUser>('User', userSchema);
