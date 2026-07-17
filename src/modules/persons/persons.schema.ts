import { z } from 'zod';

export const createPersonSchema = z.object({
  full_name: z.string().min(1),
  type: z.enum(['student', 'staff', 'employee']),
  id_number: z.string().min(1),
  department_section: z.string().optional(),
  contact_email: z.string().email().optional(),
  photo_url: z.string().url().optional(),
  rfid_uid: z.string().regex(/^[0-9A-Fa-f]+$/, 'rfid_uid must be hex'),
  status: z.enum(['active', 'inactive']).optional(),
});

export const updatePersonSchema = createPersonSchema.partial().omit({ rfid_uid: true });
export const statusSchema = z.object({ status: z.enum(['active', 'inactive']) });
export const reassignRfidSchema = z.object({
  rfid_uid: z.string().regex(/^[0-9A-Fa-f]+$/, 'rfid_uid must be hex'),
});
