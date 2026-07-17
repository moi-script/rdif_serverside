import { z } from 'zod';

export const tapSchema = z.object({
  rfid_uid: z.string().regex(/^[0-9A-Fa-f]+$/, 'rfid_uid must be hex'),
  gate_id: z.string().regex(/^[0-9a-fA-F]{24}$/, 'invalid gate_id'),
  direction: z.enum(['entry', 'exit']),
});
