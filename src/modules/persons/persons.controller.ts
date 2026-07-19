import { Request, Response } from 'express';
import { Types } from 'mongoose';
import { asyncHandler } from '../../utils/asyncHandler';
import { sendSuccess } from '../../utils/ApiResponse';
import { ApiError } from '../../utils/ApiError';
import { personService } from './persons.service';
import { dashboardService } from '../dashboard/dashboard.service';

export const personController = {
  list: asyncHandler(async (req: Request, res: Response) => {
    const { items, meta } = await personService.list(req.query);
    sendSuccess(res, items, 200, meta);
  }),
  // Full profile (profile + attendance + vehicle + recent scans) — same shape a
  // student sees on their own dashboard, but for any person the admin picks.
  overview: asyncHandler(async (req: Request, res: Response) => {
    if (!Types.ObjectId.isValid(req.params.id)) throw new ApiError('NOT_FOUND', 'Person not found');
    const data = await dashboardService.userView(req.params.id);
    if (!data.person) throw new ApiError('NOT_FOUND', 'Person not found');
    sendSuccess(res, data);
  }),
  sections: asyncHandler(async (req: Request, res: Response) => {
    sendSuccess(res, await personService.sections(req.query.type as string | undefined));
  }),
  get: asyncHandler(async (req: Request, res: Response) => {
    sendSuccess(res, await personService.get(req.params.id));
  }),
  create: asyncHandler(async (req: Request, res: Response) => {
    sendSuccess(res, await personService.create(req.body), 201);
  }),
  import: asyncHandler(async (req: Request, res: Response) => {
    sendSuccess(res, await personService.import(req.body.rows), 201);
  }),
  update: asyncHandler(async (req: Request, res: Response) => {
    sendSuccess(res, await personService.update(req.params.id, req.body));
  }),
  setStatus: asyncHandler(async (req: Request, res: Response) => {
    sendSuccess(res, await personService.setStatus(req.params.id, req.body.status));
  }),
  reassignRfid: asyncHandler(async (req: Request, res: Response) => {
    sendSuccess(res, await personService.reassignRfid(req.params.id, req.body.rfid_uid));
  }),
};
