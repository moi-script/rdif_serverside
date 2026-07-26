import bcrypt from 'bcrypt';
import { userRepo } from './users.repository';
import { IUser } from './users.model';
import { ApiError } from '../../utils/ApiError';
import { getPagination, buildMeta } from '../../utils/pagination';
import { ROLES, Role, BULK_PROTECTED } from '../../constants/roles';

const BCRYPT_ROUNDS = 12;

interface CreateUserInput {
  username: string;
  password: string;
  role: Role;
  person_id?: string | null;
}

export const userService = {
  async list(query: Record<string, string | undefined>) {
    const p = getPagination(query);
    const filter = await userRepo.buildFilter({
      type: query.type,
      department_section: query.department_section,
      search: query.search,
    });
    const { items, total } = await userRepo.findPaginatedWithPerson(filter, p);
    return { items, meta: buildMeta(total, p.page, p.limit) };
  },

  async create(input: CreateUserInput, actorRole: Role) {
    // A registrar registers people; only a superadmin mints privileged accounts.
    if (actorRole !== ROLES.SUPERADMIN && BULK_PROTECTED.includes(input.role)) {
      throw new ApiError('FORBIDDEN', 'Only a superadmin can create privileged accounts');
    }

    const existing = await userRepo.findByUsername(input.username);
    if (existing) throw new ApiError('DUPLICATE_USERNAME');

    const password_hash = await bcrypt.hash(input.password, BCRYPT_ROUNDS);
    const created = await userRepo.create({
      username: input.username,
      password_hash,
      role: input.role,
      person_id: (input.person_id as unknown as IUser['person_id']) ?? null,
      must_change_password: true,
      is_active: true,
    });
    return {
      id: String(created._id),
      username: created.username,
      role: created.role,
      person_id: created.person_id,
      must_change_password: created.must_change_password,
    };
  },

  async resetPassword(id: string, password: string) {
    const password_hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const updated = await userRepo.updateById(id, {
      password_hash,
      must_change_password: true,
      refreshTokenHash: null,
    });
    if (!updated) throw new ApiError('NOT_FOUND', 'User not found');
    return { id, updated: true };
  },

  async softDelete(id: string) {
    const updated = await userRepo.updateById(id, { is_active: false, refreshTokenHash: null });
    if (!updated) throw new ApiError('NOT_FOUND', 'User not found');
    return { id, is_active: false };
  },
};
