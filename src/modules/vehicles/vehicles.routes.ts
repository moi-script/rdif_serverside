import { Router } from 'express';
import { authenticate } from '../../middlewares/authenticate';
import { authorize } from '../../middlewares/authorize';
import { validate } from '../../middlewares/validate';
import { ROLES } from '../../constants/roles';
import { vehicleController } from './vehicles.controller';
import { createVehicleSchema, updateVehicleSchema, vehicleStatusSchema } from './vehicles.schema';

export const vehicleRoutes = Router();

// Reads are shared across the staff-side console; writes are OSS-only, enforced
// in the service by assertCanWrite('vehicle'). This deliberately reverses
// "Vehicles stay superadmin-only" from the role-system spec: vehicle
// registration is the OSS office's whole purpose.
vehicleRoutes.use(
  authenticate,
  authorize(ROLES.SUPERADMIN, ROLES.REGISTRAR, ROLES.HR, ROLES.OSS)
);
vehicleRoutes.get('/', vehicleController.list);
vehicleRoutes.get('/:id', vehicleController.get);
vehicleRoutes.post('/', validate(createVehicleSchema), vehicleController.create);
vehicleRoutes.patch('/:id', validate(updateVehicleSchema), vehicleController.update);
vehicleRoutes.patch('/:id/status', validate(vehicleStatusSchema), vehicleController.setStatus);
