import { Request, Response } from 'express';
import { asyncHandler } from '../../utils/asyncHandler';
import { sendSuccess } from '../../utils/ApiResponse';
import { gateService } from './gates.service';

export const gateController = {
  list: asyncHandler(async (_req: Request, res: Response) => {
    sendSuccess(res, await gateService.list());
  }),
  get: asyncHandler(async (req: Request, res: Response) => {
    sendSuccess(res, await gateService.get(req.params.id));
  }),
};
