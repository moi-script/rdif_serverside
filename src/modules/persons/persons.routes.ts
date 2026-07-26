import { Router } from 'express';
import { authenticate } from '../../middlewares/authenticate';
import { authorize } from '../../middlewares/authorize';
import { validate } from '../../middlewares/validate';
import { ROLES } from '../../constants/roles';
import { personController } from './persons.controller';
import {
  createPersonSchema,
  updatePersonSchema,
  statusSchema,
  reassignRfidSchema,
  importPersonsSchema,
} from './persons.schema';

export const personRoutes = Router();

personRoutes.use(authenticate, authorize(ROLES.SUPERADMIN, ROLES.REGISTRAR));

personRoutes.get('/', personController.list);
personRoutes.get('/sections', personController.sections);
personRoutes.get('/export', personController.export);
personRoutes.get('/:id/overview', personController.overview);
personRoutes.get('/:id', personController.get);
personRoutes.post('/', validate(createPersonSchema), personController.create);
personRoutes.post('/import', validate(importPersonsSchema), personController.import);
personRoutes.patch('/:id', validate(updatePersonSchema), personController.update);
personRoutes.patch('/:id/rfid', validate(reassignRfidSchema), personController.reassignRfid);

// Superadmin only — activation is not a registrar action.
personRoutes.patch(
  '/:id/status',
  authorize(ROLES.SUPERADMIN),
  validate(statusSchema),
  personController.setStatus
);
