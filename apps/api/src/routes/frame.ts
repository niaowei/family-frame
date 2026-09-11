import { Router } from 'express';
import { z } from 'zod';
import { ApiErrorCode } from '@family-frame/shared';
import type { ApiErrorResponse, FrameFeedPost, FrameFeedResponse, MediaType } from '@family-frame/shared';
import type { PrismaClient } from '@prisma/client';
import type { S3Service } from '../lib/s3';
import type { RateLimitMiddleware } from '../middleware/rateLimitTypes';

export interface FrameRouterDeps {
  prisma: PrismaClient;
  s3: S3Service | null;
  frameRateLimit: RateLimitMiddleware;
}

const feedQuerySchema = z.object({
  // MVP：limit <= 50（PRD §14）
  limit: z.coerce.number().int().min(1).max(50).default(50).optional(),
  // 游标：只返回比该 post 更新的内容（供增量拉取；M3 相框端使用全量快照）
  after: z.string().min(1).max(64).optional(),
  // 向后分页游标：只返回比该 post 更旧的内容。相框端从最新页开始整页往旧翻，
  // 页取满则继续，直到不满页——保证待接收队列超过 50 条时不漏第 51 条（E2）
  before: z.string().min(1).max(64).optional(),
});

const heartbeatSchema = z.object({
  appVersion: z.string().max(40).optional(),
  clientTime: z.string().max(40).optional(),
  cacheCount: z.number().int().min(0).max(1_000_000).optional(),
});

const completeSchema = z.object({
  mediaIds: z.array(z.string().min(1).max(64)).min(1).max(32),
});

function notFound(): ApiErrorResponse {
  return { error: ApiErrorCode.NotFound, message: '内容不存在' };
}

/**
 * 相框设备接口（PRD §14）。全部经 requireDevice（x-device-token 头）鉴权。
 */
export function frameRouter(deps: FrameRouterDeps): Router {
  const router = Router();
  const { prisma, s3 } = deps;

  router.get('/feed', deps.frameRateLimit, async (req, res, next) => {
    try {
      const device = req.device!;
      const parsed = feedQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        res.status(400).json({ error: ApiErrorCode.BadRequest, message: '查询参数不正确' } satisfies ApiErrorResponse);
        return;
      }
      const limit = parsed.data.limit ?? 50;
      if (parsed.data.after && parsed.data.before) {
        res.status(400).json({ error: ApiErrorCode.BadRequest, message: 'after 与 before 不能同时使用' } satisfies ApiErrorResponse);
        return;
      }
      let cursorPost: { id: string; createdAt: Date } | null = null;
      if (parsed.data.after ?? parsed.data.before) {
        cursorPost = await prisma.post.findFirst({
          where: { id: (parsed.data.after ?? parsed.data.before), familyId: device.familyId },
          select: { id: true, createdAt: true },
        });
        if (!cursorPost) {
          res.status(400).json({ error: ApiErrorCode.BadRequest, message: '游标无效' } satisfies ApiErrorResponse);
          return;
        }
      }

      const posts = await prisma.post.findMany({
        where: {
          familyId: device.familyId,
          deletedAt: null,
          cloudCleanedAt: null,
          ...(parsed.data.after && cursorPost
            ? {
                OR: [
                  { createdAt: { gt: cursorPost.createdAt } },
                  { createdAt: cursorPost.createdAt, id: { gt: cursorPost.id } },
                ],
              }
            : {}),
          ...(parsed.data.before && cursorPost
            ? {
                OR: [
                  { createdAt: { lt: cursorPost.createdAt } },
                  { createdAt: cursorPost.createdAt, id: { lt: cursorPost.id } },
                ],
              }
            : {}),
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: limit,
        include: {
          member: { select: { displayName: true } },
          media: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] },
        },
      });

      const body: FrameFeedResponse = {
        posts: posts.map<FrameFeedPost>((p) => ({
          id: p.id,
          messageText: p.messageText,
          createdAt: p.createdAt.toISOString(),
          member: { displayName: p.member.displayName },
          media: p.media.map((m) => ({
            id: m.id,
            type: m.type as MediaType,
            mimeType: m.mimeType,
            durationMs: m.durationMs,
          })),
        })),
        cursor: posts[0]?.id ?? null,
        serverTime: new Date().toISOString(),
      };
      res.json(body);
    } catch (err) {
      next(err);
    }
  });

  router.post('/heartbeat', deps.frameRateLimit, async (req, res, next) => {
    try {
      const device = req.device!;
      const parsed = heartbeatSchema.safeParse(req.body ?? {});
      // 上报内容不完整也不拒绝心跳：lastSeenAt 无论如何都要更新
      const appVersion = parsed.success ? parsed.data.appVersion : undefined;
      await prisma.device.update({
        where: { id: device.id },
        data: { lastSeenAt: new Date(), ...(appVersion ? { appVersion } : {}) },
      });
      res.json({ ok: true, serverTime: new Date().toISOString() });
    } catch (err) {
      next(err);
    }
  });

  router.post('/posts/:id/complete', deps.frameRateLimit, async (req, res, next) => {
    try {
      const device = req.device!;
      const postId = typeof req.params.id === 'string' ? req.params.id : '';
      const parsed = completeSchema.safeParse(req.body);
      if (!parsed.success || new Set(parsed.data.mediaIds).size !== parsed.data.mediaIds.length) {
        res.status(400).json({ error: ApiErrorCode.BadRequest, message: '落盘回执不完整' } satisfies ApiErrorResponse);
        return;
      }
      const post = await prisma.post.findFirst({
        where: { id: postId, familyId: device.familyId, deletedAt: null, cloudCleanedAt: null },
        include: { media: { select: { id: true } } },
      });
      if (!post || post.media.length !== parsed.data.mediaIds.length || post.media.some((m) => !parsed.data.mediaIds.includes(m.id))) {
        res.status(400).json({ error: ApiErrorCode.BadRequest, message: '媒体尚未完整保存' } satisfies ApiErrorResponse);
        return;
      }
      const now = new Date();
      await prisma.frameDelivery.upsert({
        where: { deviceId_postId: { deviceId: device.id, postId } },
        create: { deviceId: device.id, postId, completeAt: now, lastAttemptAt: now },
        update: { completeAt: now, lastAttemptAt: now, failureCount: 0 },
      });
      res.json({ ok: true, completeAt: now.toISOString() });
    } catch (err) { next(err); }
  });

  // seen / heard 分开保存（PRD §6 DeviceRead：firstSeenAt / heardAt）
  router.post('/posts/:id/seen', deps.frameRateLimit, async (req, res, next) => {
    try {
      const device = req.device!;
      const postId = typeof req.params.id === 'string' ? req.params.id : '';
      const post = await prisma.post.findFirst({
        where: { id: postId, familyId: device.familyId, deletedAt: null },
        select: { id: true },
      });
      if (!post) {
        res.status(404).json(notFound());
        return;
      }
      const now = new Date();
      const row = await prisma.deviceRead.upsert({
        where: { deviceId_postId: { deviceId: device.id, postId: post.id } },
        // 第一次真正展示才写 firstSeenAt，重复上报不覆盖
        create: { deviceId: device.id, postId: post.id, firstSeenAt: now },
        update: {},
      });
      // 行可能先由 heard 创建（firstSeenAt 为空）：首次 seen 时回填，已有过则不覆盖
      if (row.firstSeenAt === null) {
        await prisma.deviceRead.update({
          where: { deviceId_postId: { deviceId: device.id, postId: post.id } },
          data: { firstSeenAt: now },
        });
      }
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  router.post('/posts/:id/heard', deps.frameRateLimit, async (req, res, next) => {
    try {
      const device = req.device!;
      const postId = typeof req.params.id === 'string' ? req.params.id : '';
      const post = await prisma.post.findFirst({
        where: { id: postId, familyId: device.familyId, deletedAt: null },
        select: { id: true },
      });
      if (!post) {
        res.status(404).json(notFound());
        return;
      }
      await prisma.deviceRead.upsert({
        where: { deviceId_postId: { deviceId: device.id, postId: post.id } },
        create: { deviceId: device.id, postId: post.id, heardAt: new Date() },
        update: { heardAt: new Date() },
      });
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  // 媒体访问：<img>/<audio> 无法携带请求头，相框端用 fetch(blob) 方式经此处 302 到短期预签名 URL
  router.get('/media/:id', deps.frameRateLimit, async (req, res, next) => {
    try {
      const device = req.device!;
      if (!s3) {
        res.status(503).json({ error: ApiErrorCode.StorageUnavailable, message: '对象存储未配置' } satisfies ApiErrorResponse);
        return;
      }
      const mediaId = typeof req.params.id === 'string' ? req.params.id : '';
      const media = await prisma.media.findUnique({
        where: { id: mediaId },
        include: { post: { select: { familyId: true, deletedAt: true } } },
      });
      if (!media || media.post.deletedAt !== null || media.post.familyId !== device.familyId) {
        res.status(404).json(notFound());
        return;
      }
      const url = await s3.presignGet(media.objectKey, 300);
      res.redirect(302, url);
    } catch (err) {
      next(err);
    }
  });

  return router;
}
