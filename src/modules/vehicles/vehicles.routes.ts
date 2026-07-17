import { Router } from 'express';
import { authenticate } from '../../middlewares/authenticate';
import { authorize } from '../../middlewares/authorize';
import { validate } from '../../middlewares/validate';
import { ROLES } from '../../constants/roles';
import { vehicleController } from './vehicles.controller';
import { createVehicleSchema, updateVehicleSchema, vehicleStatusSchema } from './vehicles.schema';

export const vehicleRoutes = Router();

vehicleRoutes.use(authenticate, authorize(ROLES.ADMIN));
vehicleRoutes.get('/', vehicleController.list);
vehicleRoutes.get('/:id', vehicleController.get);
vehicleRoutes.post('/', validate(createVehicleSchema), vehicleController.create);
vehicleRoutes.patch('/:id', validate(updateVehicleSchema), vehicleController.update);
vehicleRoutes.patch('/:id/status', validate(vehicleStatusSchema), vehicleController.setStatus);
