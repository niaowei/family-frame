import { Router } from 'express';
import type { RequestHandler } from 'express';
import { z } from 'zod';
import crypto from 'node:crypto';
import { ApiErrorCode } from '@family-frame/shared';
import type { ApiErrorResponse } from '@family-frame/shared';
import { Prisma } from '@prisma/client';
import type { PrismaClient } from '@prisma/client';
import { createRateLimit } from '../middleware/rateLimit';
import { deviceTokenHash, generateDeviceToken } from '../auth/deviceToken';
import type { RateLimitMiddleware } from '../middleware/rateLimitTypes';

/**
 * 短码配对（E2 §6）：
 * - POST /api/pair/code   已登录成员生成 6 位数字短码，5 分钟有效；
 * - POST /api/pair/redeem  相框输入短码，原子单次兑换一次性 device token。
 *
 * 短码不能代替长期强凭证：兑换出的 token 与初始化设备令牌等权；
 * 生成需成员会话；兑换按 IP 限流防猜测；单码只能被一个设备兑换一次。
 * 已连接手机的日常使用不涉及短码（会话长期有效），不反复填码。
 */

export interface PairRouterDeps {
  prisma: PrismaClient;
  deviceTokenPepper: string;
  /** 成员登录校验（挂在 /code 上；/redeem 公开） */
  requireMember: RequestHandler;
  /** 生成短码限流（成员级） */
  codeRateLimit: RateLimitMiddleware;
  /** 兑换尝试限流（IP 级，防猜测） */
  redeemRateLimit: RateLimitMiddleware;
}

const CODE_TTL_MS = 5 * 60 * 1000;
/** 每家庭每 24 小时最多生成的短码数 */
const FAMILY_DAILY_CODE_CAP = 20;

const createCodeSchema = z.object({
  deviceName: z.string().trim().min(1).max(40).optional(),
});

const redeemSchema = z.object({
  code: z.string().trim().regex(/^[0-9]{6}$/, '短码是 6 位数字'),
  deviceName: z.string().trim().min(1).max(40).default('家庭相框'),
});

function randomCode(): string {
  // 6 位数字，避开全同号等弱码意义不大；等概率生成即可
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
}

export function pairRouter(deps: PairRouterDeps): Router {
  const router = Router();
  const { prisma, deviceTokenPepper } = deps;
  const deviceSecretSchema = z.object({ deviceToken: z.string().regex(/^[a-f0-9]{64}$/) });
  const startLimit = createRateLimit({ windowMs: 5 * 60_000, max: 10 });
  const statusLimit = createRateLimit({ windowMs: 60_000, max: 60 });
  const adminOnly: RequestHandler = (req, res, next) => {
    if (req.member!.role !== 'ADMIN') { res.status(403).json({ error: ApiErrorCode.Forbidden, message: '请家庭管理员绑定相框' }); return; }
    next();
  };
  router.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });

  // 新流程：相框出码 → 已登录的管理员手机输入 → 相框凭私有凭证确认绑定。
  router.post('/start', startLimit, async (req, res, next) => {
    try {
      const parsed = deviceSecretSchema.safeParse(req.body);
      if (!parsed.success) { res.status(400).json({ error: ApiErrorCode.BadRequest, message: '请在相框上重新开始绑定' }); return; }
      const tokenHash = deviceTokenHash(parsed.data.deviceToken, deviceTokenPepper);
      if (await prisma.device.findUnique({ where: { tokenHash } })) { res.json({ paired: true }); return; }
      await prisma.devicePairRequest.deleteMany({ where: { claimedAt: null, expiresAt: { lte: new Date() } } });
      let row = await prisma.devicePairRequest.findUnique({ where: { tokenHash } });
      for (let attempt = 0; !row && attempt < 8; attempt++) {
        try {
          row = await prisma.devicePairRequest.create({ data: { tokenHash, code: randomCode(), expiresAt: new Date(Date.now() + CODE_TTL_MS) } });
        } catch (err) {
          if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== 'P2002') throw err;
          row = await prisma.devicePairRequest.findUnique({ where: { tokenHash } });
        }
      }
      if (!row) { res.status(503).json({ error: ApiErrorCode.InternalError, message: '暂时无法生成设备码，请重试' }); return; }
      res.json({ paired: !!row.claimedAt, code: row.code, expiresAt: row.expiresAt });
    } catch (err) { next(err); }
  });

  router.post('/status', statusLimit, async (req, res, next) => {
    try {
      const parsed = deviceSecretSchema.safeParse(req.body);
      if (!parsed.success) { res.status(400).json({ error: ApiErrorCode.BadRequest }); return; }
      const tokenHash = deviceTokenHash(parsed.data.deviceToken, deviceTokenPepper);
      const device = await prisma.device.findUnique({ where: { tokenHash }, select: { id: true } });
      const pending = device ? null : await prisma.devicePairRequest.findUnique({ where: { tokenHash } });
      res.json({ paired: !!device, expired: !device && (!pending || pending.expiresAt <= new Date()) });
    } catch (err) { next(err); }
  });

  router.post('/claim', deps.requireMember, adminOnly, deps.redeemRateLimit, async (req, res, next) => {
    try {
      const parsed = redeemSchema.safeParse(req.body);
      if (!parsed.success) { res.status(400).json({ error: ApiErrorCode.BadRequest, message: '请输入相框显示的 6 位设备码' }); return; }
      const paired = await prisma.$transaction(async (tx) => {
        const row = await tx.devicePairRequest.findUnique({ where: { code: parsed.data.code } });
        if (!row) return false;
        const claimed = await tx.devicePairRequest.updateMany({ where: { id: row.id, claimedAt: null, expiresAt: { gt: new Date() } }, data: { claimedAt: new Date() } });
        if (claimed.count !== 1) return false;
        await tx.device.create({ data: { familyId: req.member!.familyId, name: parsed.data.deviceName, tokenHash: row.tokenHash } });
        return true;
      });
      if (!paired) { res.status(400).json({ error: ApiErrorCode.BadRequest, message: '设备码已过期、已使用或不正确，请查看相框后重试' }); return; }
      res.json({ ok: true });
    } catch (err) { next(err); }
  });

  router.post('/code', deps.requireMember, adminOnly, deps.codeRateLimit, async (req, res, next) => {
    try {
      const member = req.member!;
      const parsed = createCodeSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        res.status(400).json({ error: ApiErrorCode.BadRequest, message: '参数不正确' } satisfies ApiErrorResponse);
        return;
      }
      // 家务：清理过期短码
      await prisma.pairCode.deleteMany({ where: { expiresAt: { lt: new Date() } } });

      const dayAgo = new Date(Date.now() - 24 * 3600 * 1000);
      const recent = await prisma.pairCode.count({
        where: { familyId: member.familyId, createdAt: { gte: dayAgo } },
      });
      if (recent >= FAMILY_DAILY_CODE_CAP) {
        res.status(429).json({
          error: ApiErrorCode.RateLimited,
          message: '今天生成的短码太多了，请明天再试',
        } satisfies ApiErrorResponse);
        return;
      }

      // 生成不与当前有效短码重复的 6 位数字
      let code = '';
      for (let i = 0; i < 8; i++) {
        const candidate = randomCode();
        const clash = await prisma.pairCode.findFirst({
          where: { code: candidate, usedAt: null, expiresAt: { gt: new Date() } },
          select: { id: true },
        });
        if (!clash) {
          code = candidate;
          break;
        }
      }
      if (!code) {
        res.status(500).json({ error: ApiErrorCode.InternalError, message: '短码生成失败，请重试' } satisfies ApiErrorResponse);
        return;
      }

      const row = await prisma.pairCode.create({
        data: {
          familyId: member.familyId,
          code,
          createdBy: member.id,
          expiresAt: new Date(Date.now() + CODE_TTL_MS),
        },
      });
      res.status(201).json({ code: row.code, expiresAt: row.expiresAt.toISOString() });
    } catch (err) {
      next(err);
    }
  });

  router.post('/redeem', deps.redeemRateLimit, async (req, res, next) => {
    try {
      const parsed = redeemSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        res.status(400).json({ error: ApiErrorCode.BadRequest, message: '短码是 6 位数字' } satisfies ApiErrorResponse);
        return;
      }
      const { code, deviceName } = parsed.data;
      const now = new Date();

      // 原子单次兑换：条件更新抢到才算数，事务内建设备并返回一次性令牌
      const token = await prisma.$transaction(async (tx) => {
        const claimed = await tx.pairCode.updateMany({
          where: { code, usedAt: null, expiresAt: { gt: now } },
          data: { usedAt: now },
        });
        if (claimed.count !== 1) {
          return null;
        }
        const row = await tx.pairCode.findFirst({ where: { code }, orderBy: { usedAt: 'desc' } });
        if (!row) return null;
        const newToken = generateDeviceToken();
        await tx.device.create({
          data: {
            familyId: row.familyId,
            name: deviceName,
            tokenHash: deviceTokenHash(newToken, deviceTokenPepper),
          },
        });
        return newToken;
      });

      if (!token) {
        // 无效/过期/已用：统一文案，不区分（防探测）
        res.status(400).json({ error: ApiErrorCode.BadRequest, message: '短码无效或已过期，请家人重新生成' } satisfies ApiErrorResponse);
        return;
      }
      res.status(201).json({ deviceToken: token });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
