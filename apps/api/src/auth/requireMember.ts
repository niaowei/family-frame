import type { NextFunction, Request, Response } from 'express';
import { ApiErrorCode } from '@family-frame/shared';
import type { ApiErrorResponse } from '@family-frame/shared';
import type { PrismaClient } from '@prisma/client';
import { buildSessionCookie, SESSION_COOKIE_NAME, SESSION_TTL_SECONDS, signSession, verifySession } from './session';

/** 已登录成员上下文（附加到 req.member） */
export interface AuthenticatedMember {
  id: string;
  familyId: string;
  displayName: string;
  role: 'ADMIN' | 'MEMBER';
}

export function requireMember(prisma: PrismaClient, sessionSecret: string, isProduction = false) {
  return async function requireMemberMiddleware(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const payload = verifySession(req.cookies?.[SESSION_COOKIE_NAME], sessionSecret);
      if (!payload) {
        const body: ApiErrorResponse = {
          error: ApiErrorCode.Unauthorized,
          message: '请先登录',
        };
        res.status(401).json(body);
        return;
      }
      const member = await prisma.member.findUnique({ where: { id: payload.memberId } });
      if (!member || member.familyId !== payload.familyId || member.sessionVersion !== (payload.sessionVersion ?? 0)) {
        const body: ApiErrorResponse = {
          error: ApiErrorCode.Unauthorized,
          message: '登录状态已失效，请重新登录',
        };
        res.status(401).json(body);
        return;
      }
      req.member = {
        id: member.id,
        familyId: member.familyId,
        displayName: member.displayName,
        role: member.role,
      };
      // ponytail: 沿用签名 Cookie，最多每天续期一次；PIN 重置通过成员版本撤销所有旧登录。
      if (payload.exp - Math.floor(Date.now() / 1000) < SESSION_TTL_SECONDS - 24 * 3600) {
        const token = signSession({ memberId: member.id, familyId: member.familyId, role: member.role, sessionVersion: member.sessionVersion }, sessionSecret);
        res.setHeader('Set-Cookie', buildSessionCookie(token, isProduction));
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}
