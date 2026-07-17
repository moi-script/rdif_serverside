import { Request, Response } from 'express';
import { asyncHandler } from '../../utils/asyncHandler';
import { sendSuccess } from '../../utils/ApiResponse';
import { ApiError } from '../../utils/ApiError';
import { env } from '../../config/env';
import * as authService from './auth.service';

const REFRESH_COOKIE = 'refreshToken';
const cookieOptions = {
  httpOnly: true,
  secure: env.isProd,
  sameSite: 'strict' as const,
  path: '/',
  maxAge: 7 * 24 * 60 * 60 * 1000,
};

export const loginController = asyncHandler(async (req: Request, res: Response) => {
  const { username, password } = req.body;
  const result = await authService.login(username, password);
  res.cookie(REFRESH_COOKIE, result.refreshToken, cookieOptions);
  sendSuccess(res, { accessToken: result.accessToken, user: result.user });
});

export const refreshController = asyncHandler(async (req: Request, res: Response) => {
  const token = req.cookies?.[REFRESH_COOKIE];
  if (!token) throw new ApiError('TOKEN_INVALID', 'No refresh token');
  const result = await authService.refresh(token);
  res.cookie(REFRESH_COOKIE, result.refreshToken, cookieOptions);
  sendSuccess(res, { accessToken: result.accessToken });
});

export const logoutController = asyncHandler(async (req: Request, res: Response) => {
  if (req.user) await authService.logout(req.user.userId);
  res.clearCookie(REFRESH_COOKIE, { ...cookieOptions, maxAge: undefined });
  sendSuccess(res, { message: 'Logged out' });
});
