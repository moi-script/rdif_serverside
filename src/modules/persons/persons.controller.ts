import { Request, Response } from 'express';
import { asyncHandler } from '../../utils/asyncHandler';
import { sendSuccess } from '../../utils/ApiResponse';
import { personService } from './persons.service';

export const personController = {
  list: asyncHandler(async (req: Request, res: Response) => {
    const { items, meta } = await personService.list(req.query);
    sendSuccess(res, items, 200, meta);
  }),
  get: asyncHandler(async (req: Request, res: Response) => {
    sendSuccess(res, await personService.get(req.params.id));
  }),
  create: asyncHandler(async (req: Request, res: Response) => {
    sendSuccess(res, await personService.create(req.body), 201);
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
