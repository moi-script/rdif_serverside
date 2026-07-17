import { Request, Response } from 'express';
import { asyncHandler } from '../../utils/asyncHandler';
import { sendSuccess } from '../../utils/ApiResponse';
import { vehicleService } from './vehicles.service';

export const vehicleController = {
  list: asyncHandler(async (req: Request, res: Response) => {
    const { items, meta } = await vehicleService.list(req.query);
    sendSuccess(res, items, 200, meta);
  }),
  get: asyncHandler(async (req: Request, res: Response) => {
    sendSuccess(res, await vehicleService.get(req.params.id));
  }),
  create: asyncHandler(async (req: Request, res: Response) => {
    sendSuccess(res, await vehicleService.create(req.body), 201);
  }),
  update: asyncHandler(async (req: Request, res: Response) => {
    sendSuccess(res, await vehicleService.update(req.params.id, req.body));
  }),
  setStatus: asyncHandler(async (req: Request, res: Response) => {
    sendSuccess(res, await vehicleService.setStatus(req.params.id, req.body.status));
  }),
};
