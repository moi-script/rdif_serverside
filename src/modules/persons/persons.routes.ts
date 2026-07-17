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
} from './persons.schema';

export const personRoutes = Router();

personRoutes.use(authenticate, authorize(ROLES.ADMIN));
personRoutes.get('/', personController.list);
personRoutes.get('/:id', personController.get);
personRoutes.post('/', validate(createPersonSchema), personController.create);
personRoutes.patch('/:id', validate(updatePersonSchema), personController.update);
personRoutes.patch('/:id/status', validate(statusSchema), personController.setStatus);
personRoutes.patch('/:id/rfid', validate(reassignRfidSchema), personController.reassignRfid);
