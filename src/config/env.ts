import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().default(3000),
  API_PREFIX: z.string().default('/api'),
  MONGODB_URI: z.string().min(1),
  JWT_ACCESS_SECRET: z.string().min(1),
  JWT_REFRESH_SECRET: z.string().min(1),
  JWT_ACCESS_EXPIRES_IN: z.string().default('15m'),
  JWT_REFRESH_EXPIRES_IN: z.string().default('7d'),
  ADMIN_USERNAME: z.string().default('admin'),
  ADMIN_PASSWORD: z.string().default('changeme'),
  ALLOWED_ORIGINS: z.string().default('http://localhost:5173'),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().default(60000),
  RATE_LIMIT_MAX: z.coerce.number().default(200),
  LOGIN_RATE_LIMIT_MAX: z.coerce.number().default(10),
  SCAN_RATE_LIMIT_MAX: z.coerce.number().default(60),
  COOKIE_SECRET: z.string().default('cookie_secret'),
  LATE_CUTOFF_TIME: z.string().default('08:00'),
  OCCUPANCY_RESET_TIME: z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'OCCUPANCY_RESET_TIME must be HH:MM (24-hour)')
    .default('23:00'),
  // Validated at startup for the same reason OCCUPANCY_RESET_TIME is: a
  // malformed value here silently becomes an Invalid Date, and this one decides
  // whether a vehicle pass opens a barrier. Failing closed at boot beats silent
  // corruption.
  //
  // The regex alone only validates shape, not calendar validity: 02-30,
  // 04-31, 06-31 all match MM-DD but aren't real dates, and
  // `new Date(year, 1, 30)` doesn't throw — it silently normalises to
  // March 2. That's the same silent-corruption class the comment above
  // warns about, just reached through a gap the regex doesn't close. The
  // .refine() below closes it with a calendar round-trip: construct the
  // date and confirm the month/day you get back are the ones you asked
  // for, using a deliberately non-leap reference year so 02-29 is judged
  // on its own terms (see the comment on REFERENCE_YEAR).
  SCHOOL_YEAR_END_MMDD: z
    .string()
    .regex(/^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/, 'SCHOOL_YEAR_END_MMDD must be MM-DD')
    .default('03-31')
    .refine(
      (value) => {
        const [mm, dd] = value.split('-').map((n) => parseInt(n, 10));
        // Non-leap on purpose: nextSchoolYearEnd() has no leap-year
        // awareness, it just does `new Date(from.getFullYear(), mm - 1, dd, ...)`
        // for whatever year is current. If 02-29 were accepted here, that
        // call would silently normalise to March 1 in three years out of
        // four (every non-leap year) — the exact silent-corruption failure
        // mode this validation exists to prevent, just deferred from boot
        // time to a specific future year. Judging 02-29 against a non-leap
        // reference year rejects it at startup instead.
        const REFERENCE_YEAR = 2023;
        const date = new Date(REFERENCE_YEAR, mm - 1, dd);
        return date.getMonth() === mm - 1 && date.getDate() === dd;
      },
      {
        message:
          'SCHOOL_YEAR_END_MMDD must be a real calendar date (e.g. not 02-30, 04-31); 02-29 is rejected because it does not recur every year',
      }
    ),
  // Opt-out for the verification harnesses only — see
  // shouldBypassRateLimit() in middlewares/rateLimiter.ts for the fail-closed
  // guard. Optional and undefined by default; must never be set in production.
  VERIFY_BYPASS_TOKEN: z.string().optional(),
});

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid environment configuration:', parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = {
  ...parsed.data,
  ALLOWED_ORIGINS_LIST: parsed.data.ALLOWED_ORIGINS.split(',').map((o) => o.trim()),
  isProd: parsed.data.NODE_ENV === 'production',
};
