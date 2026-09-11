import crypto from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { ApiErrorCode } from '@family-frame/shared';
import type { ApiErrorResponse } from '@family-frame/shared';
import { extForMime, isAllowedMime, maxBytesFor } from '../lib/sniff';
import type { S3Service } from '../lib/s3';
import type { RateLimitMiddleware } from '../middleware/rateLimitTypes';

export interface UploadsRouterDeps {
  s3: S3Service | null;
  presignRateLimit: RateLimitMiddleware;
}

const presignSchema = z.object({
  type: z.enum(['photo', 'voice', 'video']),
  mimeType: z.string().min(1).max(100),
  size: z.number().int().min(1),
});

const PRESIGN_TTL_SEC = 300;

/**
 * POST /api/uploads/presign（PRD §14）
 * 只允许登录成员；校验类型白名单与大小；返回短期 PUT 凭证。
 * S3 secret 不下发浏览器（PRD §16）。
 */
export function uploadsRouter(deps: UploadsRouterDeps): Router {
  const router = Router();

  router.post('/presign', deps.presignRateLimit, async (req, res, next) => {
    try {
      if (!deps.s3) {
        res.status(503).json({
          error: ApiErrorCode.StorageUnavailable,
          message: '对象存储未配置，暂时无法上传',
        } satisfies ApiErrorResponse);
        return;
      }
      const member = req.member!;

      const parsed = presignSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          error: ApiErrorCode.BadRequest,
          message: '上传参数不正确',
        } satisfies ApiErrorResponse);
        return;
      }
      const { type, mimeType, size } = parsed.data;

      if (!isAllowedMime(type, mimeType)) {
        res.status(400).json({
          error: ApiErrorCode.BadRequest,
          message: type === 'video' ? '视频请使用 MP4 格式' : type === 'photo' ? '仅支持 JPG / PNG / WebP 图片' : '不支持的录音格式',
        } satisfies ApiErrorResponse);
        return;
      }
      const max = maxBytesFor(type);
      if (size > max) {
        res.status(400).json({
          error: ApiErrorCode.BadRequest,
          message: type === 'video' ? '视频不能超过 50MB' : type === 'photo' ? '图片过大，请重新选择' : '录音过长，请重录',
        } satisfies ApiErrorResponse);
        return;
      }

      // 上传先进 family 隔离的 staging 前缀；落库时再复制到 PRD §10 的最终 key。
      // （最终 key 含 postId，而 postId 只有在 create post 后才存在）
      // 注意：这里的 size 只是客户端声明的提前拦截，不是可信大小；
      // 真实大小在 POST /api/posts 中以 S3 HeadObject 的 ContentLength 为准。
      const key = `families/${member.familyId}/staging/${crypto.randomUUID()}.${extForMime(mimeType)}`;
      const uploadUrl = await deps.s3.presignPut(key, mimeType, PRESIGN_TTL_SEC);

      res.json({
        key,
        uploadUrl,
        expiresInSec: PRESIGN_TTL_SEC,
        headers: { 'Content-Type': mimeType },
      });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
