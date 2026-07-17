import { Role } from '../constants/roles';

export interface AuthUser {
  userId: string;
  role: Role;
  personId: string | null;
}
