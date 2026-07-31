import { z } from 'zod';

// Required list mirrors the design spec exactly: the client's real paper form
// left Email, Tel No, Driver's License No, LTO CR, and Relationship blank,
// with OR No as `~`. Everything not in this required list stays optional so a
// real, mostly-blank application is still accepted.
export const createApplicationSchema = z.object({
  category: z.enum(['new', 'renewal']),
  applicant_type: z.enum(['student', 'employee']),
  vehicle_type: z.enum(['motorcycle', 'car', 'tricycle', 'other']),
  owner_person_id: z.string().min(1),
  id_number: z.string().min(1),
  last_name: z.string().min(1),
  first_name: z.string().min(1),
  middle_name: z.string().optional(),
  year_level: z.string().optional(),
  school_year: z.string().min(1),
  email: z.string().optional(),
  mobile_no: z.string().optional(),
  tel_no: z.string().optional(),
  permanent_address: z.string().optional(),

  driver_name: z.string().optional(),
  driver_license_no: z.string().optional(),

  lto_cr_no: z.string().optional(),
  lto_cr_date: z.string().optional(),
  lto_or_no: z.string().optional(),
  lto_or_date: z.string().optional(),

  // No format regex: Philippine plates, MV file numbers and temporary plates
  // vary too much for a naive pattern to survive contact with real paperwork.
  plate_no: z.string().min(1).transform((v) => v.trim().toUpperCase()),
  mv_file_no: z.string().optional(),
  make: z.string().min(1),
  model: z.string().optional(),
  year: z.string().optional(),
  color: z.string().optional(),

  registered_owner_name: z.string().min(1),
  relationship: z.string().optional(),

  signed_name: z.string().min(1),
  signed_date: z.string().min(1),

  // Matches tapSchema's existing constraint and what real readers emit.
  rfid_uid: z.string().regex(/^[0-9A-Fa-f]+$/, 'rfid_uid must be hex'),

  valid_until: z.string().datetime().optional(),
});
