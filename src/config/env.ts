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
  SCHOOL_YEAR_END_MMDD: z
    .string()
    .regex(/^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/, 'SCHOOL_YEAR_END_MMDD must be MM-DD')
    .default('03-31'),
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
