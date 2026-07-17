import { Router } from 'express';
import { authenticate } from '../../middlewares/authenticate';
import { gateController } from './gates.controller';

export const gateRoutes = Router();

gateRoutes.use(authenticate);
gateRoutes.get('/', gateController.list);
gateRoutes.get('/:id', gateController.get);
