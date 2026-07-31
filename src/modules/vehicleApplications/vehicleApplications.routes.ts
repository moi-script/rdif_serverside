import { Router } from 'express';
import { authenticate } from '../../middlewares/authenticate';
import { authorize } from '../../middlewares/authorize';
import { validate } from '../../middlewares/validate';
import { ROLES } from '../../constants/roles';
import { vehicleApplicationController } from './vehicleApplications.controller';
import { createApplicationSchema } from './vehicleApplications.schema';

export const vehicleApplicationRoutes = Router();

// Reads are shared across the staff-side console, consistent with RBAC v2's
// "scoped writes, shared reads". Writes are OSS-only, enforced in the service
// by assertCanWrite(actor, 'vehicle').
vehicleApplicationRoutes.use(
  authenticate,
  authorize(ROLES.SUPERADMIN, ROLES.REGISTRAR, ROLES.HR, ROLES.OSS)
);

vehicleApplicationRoutes.get('/', vehicleApplicationController.list);
vehicleApplicationRoutes.get('/:id', vehicleApplicationController.get);
vehicleApplicationRoutes.post('/', validate(createApplicationSchema), vehicleApplicationController.create);

// Deliberately NO patch and NO delete. An application is the record of what was
// submitted and signed; a correction is a new application, and the older one
// stays. Immutability enforced by the absence of a route cannot be bypassed by
// a future caller, whereas immutability by convention is only a comment.
