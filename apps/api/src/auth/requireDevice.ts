import type { NextFunction, Request, Response } from 'express';
import { ApiErrorCode } from '@family-frame/shared';
import type { ApiErrorResponse } from '@family-frame/shared';
import type { PrismaClient } from '@prisma/client';
import { deviceTokenHash } from './deviceToken';

/** 已认证相框设备上下文（附加到 req.device） */
export interface AuthenticatedDevice {
  id: string;
  familyId: string;
  name: string;
}

/**
 * 设备 token 鉴权（PRD §14/§16）：
 * - token 原文只存在于相框客户端配置中，通过 x-device-token 请求头传输；
 * - 服务端只存 sha256(pepper:token) hash，数据库无原文；
 * - requestLog 只记录 method/route/status，token 不会进入任何日志。
 */
export function requireDevice(prisma: PrismaClient, deviceTokenPepper: string) {
  return async function requireDeviceMiddleware(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const token = req.header('x-device-token');
      if (!token) {
        const body: ApiErrorResponse = {
          error: ApiErrorCode.Unauthorized,
          message: '设备未认证',
        };
        res.status(401).json(body);
        return;
      }
      const device = await prisma.device.findUnique({
        where: { tokenHash: deviceTokenHash(token, deviceTokenPepper) },
      });
      if (!device) {
        const body: ApiErrorResponse = {
          error: ApiErrorCode.Unauthorized,
          message: '设备令牌无效',
        };
        res.status(401).json(body);
        return;
      }
      req.device = { id: device.id, familyId: device.familyId, name: device.name };
      next();
    } catch (err) {
      next(err);
    }
  };
}
