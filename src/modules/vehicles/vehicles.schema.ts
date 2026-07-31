import { z } from 'zod';

export const createVehicleSchema = z.object({
  owner_person_id: z.string().min(1),
  plate_number: z.string().min(1),
  rfid_uid: z.string().regex(/^[0-9A-Fa-f]+$/, 'rfid_uid must be hex'),
  vehicle_type: z.enum(['motorcycle', 'car', 'tricycle', 'other']),
  make: z.string().optional(),
  vehicle_model: z.string().optional(),
  color: z.string().optional(),
  valid_until: z.string().datetime().optional(),
  photo_url: z.string().url().optional(),
  status: z.enum(['active', 'inactive']).optional(),
});

export const updateVehicleSchema = createVehicleSchema.partial();
export const vehicleStatusSchema = z.object({ status: z.enum(['active', 'inactive']) });
