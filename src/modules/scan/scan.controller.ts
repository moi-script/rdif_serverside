import { Request, Response } from 'express';
import { asyncHandler } from '../../utils/asyncHandler';
import { sendSuccess } from '../../utils/ApiResponse';
import { scanService } from './scan.service';

export const scanController = {
  tap: asyncHandler(async (req: Request, res: Response) => {
    const result = await scanService.tap(req.body);
    sendSuccess(res, result, 200); // always 200 — denied is a business outcome
  }),
  logs: asyncHandler(async (req: Request, res: Response) => {
    const { items, meta } = await scanService.listLogs(req.query as Record<string, string>);
    sendSuccess(res, items, 200, meta);
  }),
};
