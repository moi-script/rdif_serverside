import { Router } from 'express';
import { authenticate } from '../../middlewares/authenticate';
import { authorize } from '../../middlewares/authorize';
import { validate } from '../../middlewares/validate';
import { ROLES } from '../../constants/roles';
import { userController } from './users.controller';
import {
  createUserSchema,
  resetPasswordSchema,
  userStatusSchema,
  bulkStatusSchema,
  bulkFilterSchema,
} from './users.schema';

export const userRoutes = Router();

userRoutes.use(authenticate);

// Registrar may create logins and check for duplicates.
userRoutes.get('/', authorize(ROLES.SUPERADMIN, ROLES.REGISTRAR), userController.list);
userRoutes.post(
  '/',
  authorize(ROLES.SUPERADMIN, ROLES.REGISTRAR),
  validate(createUserSchema),
  userController.create
);

// Superadmin only.
userRoutes.patch(
  '/:id/password',
  authorize(ROLES.SUPERADMIN),
  validate(resetPasswordSchema),
  userController.resetPassword
);
userRoutes.delete('/:id', authorize(ROLES.SUPERADMIN), userController.remove);

// Bulk routes must be registered above `/:id/status` — Express matches in
// declaration order, and `bulk-status` would otherwise be captured by `:id`.
userRoutes.get(
  '/bulk-status/preview',
  authorize(ROLES.SUPERADMIN),
  validate(bulkFilterSchema, 'query'),
  userController.bulkPreview
);
userRoutes.post(
  '/bulk-status',
  authorize(ROLES.SUPERADMIN),
  validate(bulkStatusSchema),
  userController.bulkSetStatus
);

userRoutes.patch(
  '/:id/status',
  authorize(ROLES.SUPERADMIN),
  validate(userStatusSchema),
  userController.setStatus
);
