import { z } from 'zod';
import { ALL_ROLES } from '../../constants/roles';

export const createUserSchema = z.object({
  username: z.string().min(3),
  password: z.string().min(8),
  role: z.enum(ALL_ROLES as unknown as [string, ...string[]]),
  person_id: z.string().nullable().optional(),
});

export const resetPasswordSchema = z.object({
  password: z.string().min(8),
});

export const userStatusSchema = z.object({
  active: z.boolean(),
});

export const bulkStatusSchema = z.object({
  active: z.boolean(),
  filter: z
    .object({
      type: z.string().optional(),
      department_section: z.string().optional(),
      search: z.string().optional(),
    })
    .default({}),
});
