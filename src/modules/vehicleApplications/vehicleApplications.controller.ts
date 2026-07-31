import { Request, Response } from 'express';
import { asyncHandler } from '../../utils/asyncHandler';
import { sendSuccess } from '../../utils/ApiResponse';
import { actorOf } from '../../utils/authority';
import { vehicleApplicationService } from './vehicleApplications.service';

export const vehicleApplicationController = {
  list: asyncHandler(async (req: Request, res: Response) => {
    const { items, meta } = await vehicleApplicationService.list(req.query);
    sendSuccess(res, items, 200, meta);
  }),
  get: asyncHandler(async (req: Request, res: Response) => {
    sendSuccess(res, await vehicleApplicationService.get(req.params.id));
  }),
  create: asyncHandler(async (req: Request, res: Response) => {
    sendSuccess(res, await vehicleApplicationService.create(req.body, actorOf(req)), 201);
  }),
};
