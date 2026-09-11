import crypto from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { ApiErrorCode } from '@family-frame/shared';
import type { ApiErrorResponse, MediaType, PostSummary } from '@family-frame/shared';
import { extForMime, isAllowedMime, maxBytesFor, sniffMime } from '../lib/sniff';
import type { S3Service } from '../lib/s3';
import type { PrismaClient } from '@prisma/client';
import { features } from '../config/features';
import type { RateLimitMiddleware } from '../middleware/rateLimitTypes';

export interface PostsRouterDeps {
  prisma: PrismaClient;
  s3: S3Service | null;
  postsRateLimit: RateLimitMiddleware;
}

const MAX_MESSAGE_CHARS = 80;
const MAX_PHOTOS = 9;
const MAX_VOICE_MS = 30_000 + 1_000; // 30 秒 + 1 秒容差

const createPostSchema = z.object({
  messageText: z
    .string()
    .max(MAX_MESSAGE_CHARS, '留言最多 80 个字')
    .transform((v) => v.trim())
    .transform((v) => (v.length > 0 ? v : null)),
  photoKeys: z.array(z.string().min(1).max(512)).max(MAX_PHOTOS).default([]),
  videoKey: z.string().min(1).max(512).optional(),
  voiceKey: z.string().min(1).max(512).optional(),
  photoMeta: z
    .record(z.string(), z.object({ width: z.number().int().min(1).max(20000), height: z.number().int().min(1).max(20000) }))
    .optional(),
  voiceDurationMs: z.number().int().min(1).max(MAX_VOICE_MS).optional(),
}).refine((v) => v.videoKey ? v.photoKeys.length === 0 && !v.voiceKey : v.photoKeys.length > 0,
  '请选择照片或一个视频，视频请单独发送');

const listSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

function stagingPrefix(familyId: string): string {
  return `families/${familyId}/staging/`;
}

function badRequest(message: string): ApiErrorResponse {
  return { error: ApiErrorCode.BadRequest, message };
}

export function postsRouter(deps: PostsRouterDeps): Router {
  const router = Router();
  const { prisma, s3 } = deps;

  router.post('/', deps.postsRateLimit, async (req, res, next) => {
    try {
      const member = req.member!;
      if (!s3) {
        res.status(503).json({
          error: ApiErrorCode.StorageUnavailable,
          message: '对象存储未配置，暂时无法发送',
        } satisfies ApiErrorResponse);
        return;
      }

      const parsed = createPostSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json(badRequest(parsed.error.issues[0]?.message ?? '发送内容不正确'));
        return;
      }
      const { messageText, photoKeys, voiceKey, videoKey, photoMeta, voiceDurationMs } = parsed.data;

      // key 必须属于本家庭 staging 前缀，防止跨家庭写入（PRD §16 防任意上传）
      const allKeys = [...photoKeys, ...(voiceKey ? [voiceKey] : []), ...(videoKey ? [videoKey] : [])];
      for (const key of allKeys) {
        if (!key.startsWith(stagingPrefix(member.familyId))) {
          res.status(400).json(badRequest('上传文件无效，请重新发送'));
          return;
        }
      }

      // 逐个校验对象真实存在、大小合规、魔数与类型匹配（不信任浏览器声明）。
      // 大小以 S3 HeadObject 返回的真实 ContentLength 为准（presign 时的客户端 size 仅供提前拦截）。
      // 全部校验发生在创建 Post / 复制对象 / 写 Media 之前，拒绝路径不产生任何数据库状态。
      const sniffedMimes = new Map<string, string>();
      const rejectAndCleanup = async (message: string): Promise<void> => {
        // 尽量清理本次请求的 staging 对象（key 均已通过本家庭前缀校验，删除安全且幂等）
        for (const key of allKeys) {
          await s3.deleteObject(key).catch(() => undefined);
        }
        res.status(400).json(badRequest(message));
      };
      for (const key of allKeys) {
        const type = key === videoKey ? 'video' : key === voiceKey ? 'voice' : 'photo';
        const head = await s3.headObject(key);
        if (!head || head.size <= 0) {
          await rejectAndCleanup('上传未完成，请重试');
          return;
        }
        if (head.size > maxBytesFor(type)) {
          await rejectAndCleanup('文件过大，请重新选择');
          return;
        }
        const magic = await s3.getHeadBytes(key, 16);
        const sniffed = sniffMime(magic, type);
        if (!sniffed || !isAllowedMime(type, sniffed)) {
          await rejectAndCleanup(type === 'video' ? '文件不是有效的 MP4 文件' : type === 'photo' ? '文件不是有效的图片' : '文件不是有效的录音');
          return;
        }
        sniffedMimes.set(key, sniffed);
      }

      // 1) 先建 post 拿到真实 id（PRD §10 最终 key 必须含 postId）
      // 2) 复制对象到最终 key  3) 写 media 行  4) 清理 staging
      // 任一步失败则回滚，保证存储与数据库一致。
      let post;
      try {
        post = await prisma.post.create({
          data: { familyId: member.familyId, memberId: member.id, messageText, photoCount: photoKeys.length },
        });
      } catch (err) {
        next(err);
        return;
      }

      const finalPhotoKeys: string[] = [];
      let finalVoice: { key: string; mime: string } | null = null;
      let finalVideo: string | null = null;
      try {
        if (videoKey) {
          finalVideo = `families/${member.familyId}/posts/${post.id}/video-${crypto.randomUUID()}.mp4`;
          await s3.copyObject(videoKey, finalVideo);
        }
        for (const key of photoKeys) {
          const mime = sniffedMimes.get(key)!;
          const finalKey = `families/${member.familyId}/posts/${post.id}/photo-${crypto.randomUUID()}.${extForMime(mime)}`;
          await s3.copyObject(key, finalKey);
          finalPhotoKeys.push(finalKey);
        }
        if (voiceKey) {
          const mime = sniffedMimes.get(voiceKey);
          if (!mime) throw new Error('voice mime sniffing failed unexpectedly');
          const key = `families/${member.familyId}/posts/${post.id}/voice-${crypto.randomUUID()}.${extForMime(mime)}`;
          await s3.copyObject(voiceKey, key);
          finalVoice = { key, mime };
        }

        await prisma.media.createMany({
          data: [
            ...(finalVideo ? [{ postId: post.id, type: 'VIDEO' as const, objectKey: finalVideo, mimeType: 'video/mp4' }] : []),
            ...finalPhotoKeys.map((key, i) => {
              const sourceKey = photoKeys[i]!;
              return {
                postId: post.id,
                type: 'PHOTO' as const,
                objectKey: key,
                mimeType: sniffedMimes.get(sourceKey)!,
                width: photoMeta?.[sourceKey]?.width ?? null,
                height: photoMeta?.[sourceKey]?.height ?? null,
              };
            }),
            ...(finalVoice
              ? [
                  {
                    postId: post.id,
                    type: 'VOICE' as const,
                    objectKey: finalVoice.key,
                    mimeType: finalVoice.mime,
                    durationMs: voiceDurationMs ?? null,
                  },
                ]
              : []),
          ],
        });
      } catch (err) {
        // 回滚：删除已复制的对象，删除无 media 的 post 行
        for (const key of [...finalPhotoKeys, ...(finalVoice ? [finalVoice.key] : []), ...(finalVideo ? [finalVideo] : [])]) {
          await s3.deleteObject(key).catch(() => undefined);
        }
        await prisma.post.delete({ where: { id: post.id } }).catch(() => undefined);
        next(err);
        return;
      }

      // 清理 staging（失败不阻塞，staging 由前缀隔离可后续清理）
      for (const key of allKeys) {
        await s3.deleteObject(key).catch(() => undefined);
      }

      res.status(201).json({ post: { id: post.id, createdAt: post.createdAt.toISOString() } });
    } catch (err) {
      next(err);
    }
  });

  router.get('/', deps.postsRateLimit, async (req, res, next) => {
    try {
      const member = req.member!;
      const parsed = listSchema.safeParse(req.query);
      const limit = parsed.success ? parsed.data.limit : 50;

      const posts = await prisma.post.findMany({
        where: { familyId: member.familyId, deletedAt: null, cloudCleanedAt: null },
        orderBy: { createdAt: 'desc' },
        take: limit,
        include: {
          member: { select: { id: true, displayName: true } },
          media: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] },
          deliveries: { select: { deviceId: true, completeAt: true } },
        },
      });

      const items: PostSummary[] = posts.map((p) => ({
        id: p.id,
        messageText: p.messageText,
        createdAt: p.createdAt.toISOString(),
        member: p.member,
        media: p.media.map((m) => ({
          id: m.id,
          type: m.type as MediaType,
          mimeType: m.mimeType,
          durationMs: m.durationMs,
        })),
      }));
      const now = new Date();
      const day = 86_400_000;
      const todayStart = new Date(Math.floor(now.getTime() / day) * day);
      const yesterdayStart = new Date(todayStart.getTime() - day);
      const yesterday = await prisma.post.aggregate({
        where: { familyId: member.familyId, deletedAt: null, createdAt: { gte: yesterdayStart, lt: todayStart } },
        _sum: { photoCount: true },
      });
      const devices = await prisma.device.findMany({ where: { familyId: member.familyId }, select: { id: true, createdAt: true } });
      const pendingToday = posts.filter((post) => devices.some((device) => device.createdAt <= post.createdAt) &&
        devices.filter((device) => device.createdAt <= post.createdAt).some((device) => !post.deliveries?.some((d) => d.deviceId === device.id && d.completeAt)));
      res.json({ posts: items, yesterdayPhotoCount: yesterday._sum.photoCount ?? 0, pendingPostCount: pendingToday.length });
    } catch (err) {
      next(err);
    }
  });

  router.delete('/:id', deps.postsRateLimit, async (req, res, next) => {
    try {
      const member = req.member!;
      const rawId = req.params.id;
      const id = typeof rawId === 'string' ? rawId : undefined;
      if (!id) {
        res.status(404).json({ error: ApiErrorCode.NotFound, message: '内容不存在' } satisfies ApiErrorResponse);
        return;
      }
      const post = await prisma.post.findFirst({
        where: { id, familyId: member.familyId, deletedAt: null },
      });
      if (!post) {
        res.status(404).json({ error: ApiErrorCode.NotFound, message: '内容不存在' } satisfies ApiErrorResponse);
        return;
      }
      const allowed =
        member.role === 'ADMIN' ||
        (features.memberCanDeleteOwnPost && post.memberId === member.id);
      if (!allowed) {
        res.status(403).json({ error: ApiErrorCode.Forbidden, message: '没有权限删除' } satisfies ApiErrorResponse);
        return;
      }
      await prisma.post.update({ where: { id }, data: { deletedAt: new Date() } });
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
