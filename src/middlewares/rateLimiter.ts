import rateLimit from 'express-rate-limit';
import { env } from '../config/env';

const handler = (_req: unknown, res: { status: (n: number) => { json: (b: unknown) => void } }) =>
  res.status(429).json({ success: false, code: 'RATE_LIMITED', message: 'Too many requests' });

export const globalLimiter = rateLimit({
  windowMs: env.RATE_LIMIT_WINDOW_MS,
  max: env.RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  handler,
});

export const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: env.LOGIN_RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  handler,
});

export const scanLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: env.SCAN_RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  handler,
});
