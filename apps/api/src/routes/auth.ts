import { Router } from 'express';
import type { RequestHandler, Response } from 'express';
import crypto from 'node:crypto';
import { z } from 'zod';
import { ApiErrorCode } from '@family-frame/shared';
import type { ApiErrorResponse, MemberProfile } from '@family-frame/shared';
import type { PrismaClient } from '@prisma/client';
import { buildClearSessionCookie, buildSessionCookie, signSession } from '../auth/session';
import { hashPin, verifyPin } from '../auth/pin';
import { createRateLimit } from '../middleware/rateLimit';
import type { RateLimitMiddleware } from '../middleware/rateLimitTypes';

export interface AuthRouterDeps {
  prisma: PrismaClient;
  sessionSecret: string;
  isProduction: boolean;
  loginRateLimit: RateLimitMiddleware;
  requireMember: RequestHandler;
}

const loginSchema = z.object({
  familyCode: z.string().trim().min(1).max(64),
  member: z.string().trim().min(1).max(40).optional(),
  memberId: z.string().min(1).max(64).optional(),
  pin: z.string().min(4).max(20),
}).refine((v) => !!(v.memberId || v.member));

export const newPinSchema = z.string().regex(/^\d{6,20}$/, '请设置 6 至 20 位数字 PIN');
export const invitationHash = (token: string): string => crypto.createHash('sha256').update(token).digest('hex');
const joinSchema = z.object({ token: z.string().regex(/^[a-f0-9]{64}$/), displayName: z.string().trim().min(1).max(40), pin: newPinSchema });

export function authRouter(deps: AuthRouterDeps): Router {
  const router = Router();
  const { prisma, sessionSecret, isProduction } = deps;
  router.use('/api/auth', (_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  const recoveryLimit = createRateLimit({ windowMs: 15 * 60_000, max: 10,
    keyFn: (req) => `${String(req.body?.familyCode ?? '').slice(0, 64)}:${String(req.body?.memberId ?? req.body?.member ?? '').slice(0, 64)}` });
  const lookupLimit = createRateLimit({ windowMs: 60_000, max: 60 });
  const setLogin = (res: Response, found: MemberProfile & { sessionVersion: number }) => {
    const token = signSession({ memberId: found.id, familyId: found.familyId, role: found.role, sessionVersion: found.sessionVersion }, sessionSecret);
    res.setHeader('Set-Cookie', buildSessionCookie(token, isProduction));
    const profile: MemberProfile = { id: found.id, familyId: found.familyId, displayName: found.displayName, role: found.role };
    return profile;
  };

  // 登录失败统一返回同一文案，不暴露「成员不存在」还是「密码错误」
  const invalidCredentials = (): ApiErrorResponse => ({
    error: ApiErrorCode.Unauthorized,
    message: '家庭、成员或 PIN 不正确',
  });

  router.post('/api/auth/login', deps.loginRateLimit, recoveryLimit, async (req, res, next) => {
    try {
      const parsed = loginSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          error: ApiErrorCode.BadRequest,
          message: '请打开家庭入口，选择自己的名字并填写 PIN',
        } satisfies ApiErrorResponse);
        return;
      }
      const { familyCode, member, memberId, pin } = parsed.data;

      const family = await prisma.family.findUnique({ where: { code: familyCode } });
      const found = family
        ? await prisma.member.findFirst({
            where: { familyId: family.id, ...(memberId ? { id: memberId } : { displayName: member }) },
          })
        : null;
      const ok = found ? await verifyPin(pin, found.pinHash) : false;
      if (!family || !found || !ok) {
        res.status(401).json(invalidCredentials());
        return;
      }

      res.json({ member: setLogin(res, found), familyCode: family.code });
    } catch (err) {
      next(err);
    }
  });

  router.get('/api/auth/family/:code', lookupLimit, async (req, res, next) => {
    try {
      const code = z.string().min(1).max(64).safeParse(req.params.code);
      const family = code.success ? await prisma.family.findUnique({ where: { code: code.data },
        select: { id: true, name: true, code: true, members: { select: { id: true, displayName: true }, orderBy: { createdAt: 'asc' } } } }) : null;
      if (!family) {
        res.status(404).json({ error: ApiErrorCode.NotFound, message: '家庭入口无效，请向家人索取入口链接' });
        return;
      }
      res.json(family);
    } catch (err) {
      next(err);
    }
  });

  router.get('/api/auth/invitation/:token', lookupLimit, async (req, res, next) => {
    try {
      const parsed = z.string().regex(/^[a-f0-9]{64}$/).safeParse(req.params.token);
      const invitation = parsed.success ? await prisma.familyInvitation.findFirst({
        where: { tokenHash: invitationHash(parsed.data), usedAt: null, revokedAt: null, expiresAt: { gt: new Date() } },
        select: { family: { select: { name: true, code: true } } },
      }) : null;
      if (!invitation) { res.status(400).json({ error: ApiErrorCode.BadRequest, message: '邀请已使用、过期或撤销，请家人重新邀请' }); return; }
      res.json(invitation.family);
    } catch (err) { next(err); }
  });

  router.post('/api/auth/join', deps.loginRateLimit, async (req, res, next) => {
    try {
      const parsed = joinSchema.safeParse(req.body);
      if (!parsed.success) { res.status(400).json({ error: ApiErrorCode.BadRequest, message: '请填写名字和 6 至 20 位数字 PIN，并使用有效邀请链接' }); return; }
      const { token, displayName, pin } = parsed.data;
      const tokenHash = invitationHash(token);
      const invitation = await prisma.familyInvitation.findUnique({ where: { tokenHash } });
      if (!invitation || invitation.usedAt || invitation.revokedAt || invitation.expiresAt <= new Date()) {
        res.status(400).json({ error: ApiErrorCode.BadRequest, message: '邀请已使用、过期或撤销，请家人重新邀请' }); return;
      }
      const pinHash = await hashPin(pin);
      const result = await prisma.$transaction(async (tx) => {
        // ponytail: 每户加入时锁定一行，防止不同邀请并发创建同名成员；保留已有历史成员。
        await tx.$queryRaw`SELECT id FROM families WHERE id = ${invitation.familyId} FOR UPDATE`;
        const duplicate = await tx.member.findFirst({ where: { familyId: invitation.familyId, displayName } });
        if (duplicate) return { error: '这个名字已在家庭中，请从家庭入口登录；新成员请使用不同的名字' };
        const claimed = await tx.familyInvitation.updateMany({ where: { id: invitation.id, usedAt: null, revokedAt: null, expiresAt: { gt: new Date() } }, data: { usedAt: new Date() } });
        if (claimed.count !== 1) return { error: '邀请已使用、过期或撤销，请家人重新邀请' };
        const member = await tx.member.create({ data: { familyId: invitation.familyId, displayName, pinHash, role: 'MEMBER' } });
        const family = await tx.family.findUniqueOrThrow({ where: { id: invitation.familyId } });
        return { member, familyCode: family.code };
      });
      if ('error' in result) { res.status(400).json({ error: ApiErrorCode.BadRequest, message: result.error }); return; }
      res.status(201).json({ member: setLogin(res, result.member), familyCode: result.familyCode });
    } catch (err) { next(err); }
  });

  router.get('/api/auth/me', deps.requireMember, async (req, res, next) => {
    try {
      const family = await prisma.family.findUniqueOrThrow({ where: { id: req.member!.familyId }, select: { code: true } });
      res.json({ member: req.member, familyCode: family.code });
    } catch (err) { next(err); }
  });

  router.post('/api/auth/logout', (req, res) => {
    res.setHeader('Set-Cookie', buildClearSessionCookie(isProduction));
    res.json({ ok: true });
  });

  return router;
}
