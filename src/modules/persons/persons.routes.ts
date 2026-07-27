import { Router } from 'express';
import { authenticate } from '../../middlewares/authenticate';
import { authorize } from '../../middlewares/authorize';
import { validate } from '../../middlewares/validate';
import { ROLES } from '../../constants/roles';
import { personController } from './persons.controller';
import { uploadPhoto } from '../../middlewares/uploadPhoto';
import {
  createPersonSchema,
  updatePersonSchema,
  statusSchema,
  reassignRfidSchema,
  importPersonsSchema,
} from './persons.schema';

export const personRoutes = Router();

// Declared before the router-level authorize on purpose: any authenticated
// user may fetch a photo (a student's dashboard renders their own), while
// everything below is registrar/superadmin only.
personRoutes.get('/:id/photo', authenticate, personController.getPhoto);

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
personRoutes.post('/:id/photo', uploadPhoto, personController.uploadPhoto);
personRoutes.delete('/:id/photo', personController.deletePhoto);

// Superadmin only — activation is not a registrar action.
personRoutes.patch(
  '/:id/status',
  authorize(ROLES.SUPERADMIN),
  validate(statusSchema),
  personController.setStatus
);
