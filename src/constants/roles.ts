export const ROLES = {
  SUPERADMIN: 'superadmin',
  REGISTRAR: 'registrar',
  STAFF: 'staff',
  STUDENT: 'student',
} as const;

export type Role = (typeof ROLES)[keyof typeof ROLES];

/** Roles that get the staff-side console at /admin. */
export const STAFF_SIDE: readonly Role[] = [ROLES.SUPERADMIN, ROLES.REGISTRAR];

/** Roles a bulk status change may never affect, regardless of filter. */
export const BULK_PROTECTED: readonly Role[] = [ROLES.SUPERADMIN, ROLES.REGISTRAR];

/** Every valid role, for Zod enums and Mongoose enums. */
export const ALL_ROLES: readonly Role[] = [
  ROLES.SUPERADMIN,
  ROLES.REGISTRAR,
  ROLES.STAFF,
  ROLES.STUDENT,
];
