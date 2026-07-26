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
    sendSuccess(res, await userService.create(req.body, req.user!.role), 201);
  }),
  resetPassword: asyncHandler(async (req: Request, res: Response) => {
    sendSuccess(res, await userService.resetPassword(req.params.id, req.body.password));
  }),
  remove: asyncHandler(async (req: Request, res: Response) => {
    sendSuccess(res, await userService.softDelete(req.params.id));
  }),
  setStatus: asyncHandler(async (req: Request, res: Response) => {
    sendSuccess(
      res,
      await userService.setStatus(req.params.id, req.body.active, req.user!.userId)
    );
  }),
  bulkPreview: asyncHandler(async (req: Request, res: Response) => {
    const q = req.query as Record<string, string | undefined>;
    sendSuccess(
      res,
      await userService.bulkPreview(
        { type: q.type, department_section: q.department_section, search: q.search },
        req.user!.userId
      )
    );
  }),
  bulkSetStatus: asyncHandler(async (req: Request, res: Response) => {
    sendSuccess(
      res,
      await userService.bulkSetStatus(req.body.active, req.body.filter ?? {}, req.user!.userId)
    );
  }),
};
