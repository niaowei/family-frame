import { Router } from 'express';
import { ApiErrorCode } from '@family-frame/shared';
import type { ApiErrorResponse } from '@family-frame/shared';
import type { PrismaClient } from '@prisma/client';
import type { S3Service } from '../lib/s3';

export interface MediaRouterDeps {
  prisma: PrismaClient;
  s3: S3Service | null;
}

/**
 * GET /api/media/:id — 已登录成员访问本家庭媒体。
 * 302 跳转到短期预签名 GET URL（默认 5 分钟），objectKey 不直接下发。
 */
export function mediaRouter(deps: MediaRouterDeps): Router {
  const router = Router();
  const { prisma, s3 } = deps;

  router.get('/:id', async (req, res, next) => {
    try {
      const member = req.member!;
      if (!s3) {
        res.status(503).json({
          error: ApiErrorCode.StorageUnavailable,
          message: '对象存储未配置',
        } satisfies ApiErrorResponse);
        return;
      }
      const media = await prisma.media.findUnique({
        where: { id: req.params.id },
        include: { post: { select: { familyId: true, deletedAt: true } } },
      });
      if (!media || media.post.deletedAt !== null || media.post.familyId !== member.familyId) {
        res.status(404).json({ error: ApiErrorCode.NotFound, message: '内容不存在' } satisfies ApiErrorResponse);
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
