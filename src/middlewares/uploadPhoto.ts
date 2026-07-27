import { Request, Response, NextFunction } from 'express';
import multer from 'multer';
import { ApiError } from '../utils/ApiError';

export const MAX_PHOTO_BYTES = 1_048_576;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_PHOTO_BYTES, files: 1 },
}).single('photo');

/**
 * Multer reports its own errors rather than throwing ApiError, so they are
 * translated here. A size overrun is 413, not a generic validation failure.
 */
export function uploadPhoto(req: Request, res: Response, next: NextFunction): void {
  upload(req, res, (err: unknown) => {
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        next(new ApiError('PAYLOAD_TOO_LARGE'));
        return;
      }
      next(new ApiError('VALIDATION_ERROR', err.message));
      return;
    }
    if (err) {
      next(err);
      return;
    }
    next();
  });
}
