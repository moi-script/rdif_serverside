import { Router } from 'express';
import { validate } from '../../middlewares/validate';
import { authenticate } from '../../middlewares/authenticate';
import { loginLimiter } from '../../middlewares/rateLimiter';
import { loginSchema } from './auth.schema';
import { loginController, refreshController, logoutController } from './auth.controller';

export const authRoutes = Router();

authRoutes.post('/login', loginLimiter, validate(loginSchema), loginController);
authRoutes.post('/refresh', refreshController);
authRoutes.post('/logout', authenticate, logoutController);
