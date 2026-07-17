import { z } from 'zod';

export const createUserSchema = z.object({
  username: z.string().min(3),
  password: z.string().min(8),
  role: z.enum(['user']).default('user'), // admins are seeded only, never created via API
  person_id: z.string().nullable().optional(),
});

export const resetPasswordSchema = z.object({
  password: z.string().min(8),
});
