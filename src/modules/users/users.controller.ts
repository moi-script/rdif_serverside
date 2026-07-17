import { Request, Response } from 'express';
import { asyncHandler } from '../../utils/asyncHandler';
import { sendSuccess } from '../../utils/ApiResponse';
import { userService } from './users.service';

export const userController = {
  list: asyncHandler(async (req: Request, res: Response) => {
    const { items, meta } = await userService.list(req.query as Record<string, string>);
    sendSuccess(res, items, 200, meta);
  }),
  create: asyncHandler(async (req: Request, res: Response) => {
    sendSuccess(res, await userService.create(req.body), 201);
  }),
  resetPassword: asyncHandler(async (req: Request, res: Response) => {
    sendSuccess(res, await userService.resetPassword(req.params.id, req.body.password));
  }),
  remove: asyncHandler(async (req: Request, res: Response) => {
    sendSuccess(res, await userService.softDelete(req.params.id));
  }),
};
