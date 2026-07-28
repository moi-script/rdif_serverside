import { Router } from 'express';
import { authenticate } from '../../middlewares/authenticate';
import { authenticateAny } from '../../middlewares/authenticateAny';
import { authorize } from '../../middlewares/authorize';
import { validate } from '../../middlewares/validate';
import { ROLES } from '../../constants/roles';
import { personController } from './persons.controller';
import { uploadPhoto, uploadSignature } from '../../middlewares/uploadImage';
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
// everything below is registrar/superadmin only. A gate terminal has no user
// session but is the main consumer of face photos, so this route also
// accepts a device key.
personRoutes.get('/:id/photo', authenticateAny, personController.getPhoto);

// Also declared before the router-level authorize: a signature is the one
// thing a portal user contributes to their own record, so student and staff
// accounts must be able to write here. Ownership is enforced per-request in
// personSignatures.service — registrars and superadmins pass the same check,
// which is what lets them capture a signature at the desk. No device key:
// unlike a face photo, a gate has no use for a signature.
personRoutes.get('/:id/signature', authenticate, personController.getSignature);
personRoutes.post(
  '/:id/signature',
  authenticate,
  uploadSignature,
  personController.uploadSignature
);
personRoutes.delete('/:id/signature', authenticate, personController.deleteSignature);

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
