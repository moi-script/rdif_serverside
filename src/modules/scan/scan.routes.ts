import { Router } from 'express';
import { authenticate } from '../../middlewares/authenticate';
import { authorize } from '../../middlewares/authorize';
import { validate } from '../../middlewares/validate';
import { scanLimiter } from '../../middlewares/rateLimiter';
import { ROLES } from '../../constants/roles';
import { scanController } from './scan.controller';
import { tapSchema } from './scan.schema';

export const scanRoutes = Router();

scanRoutes.use(authenticate);
scanRoutes.post('/tap', scanLimiter, validate(tapSchema), scanController.tap);
scanRoutes.get('/logs', authorize(ROLES.ADMIN), scanController.logs);
