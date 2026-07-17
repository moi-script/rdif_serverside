import { Router } from 'express';
import { authenticate } from '../../middlewares/authenticate';
import { authorize } from '../../middlewares/authorize';
import { validate } from '../../middlewares/validate';
import { ROLES } from '../../constants/roles';
import { userController } from './users.controller';
import { createUserSchema, resetPasswordSchema } from './users.schema';

export const userRoutes = Router();

userRoutes.use(authenticate, authorize(ROLES.ADMIN));
userRoutes.get('/', userController.list);
userRoutes.post('/', validate(createUserSchema), userController.create);
userRoutes.patch('/:id/password', validate(resetPasswordSchema), userController.resetPassword);
userRoutes.delete('/:id', userController.remove);
