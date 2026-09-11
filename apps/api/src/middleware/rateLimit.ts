import type { NextFunction, Request, Response } from 'express';
import { ApiErrorCode } from '@family-frame/shared';
import type { ApiErrorResponse } from '@family-frame/shared';

/**
 * 简单内存限流（PRD §16：API 有简单限流）。
 * 固定窗口计数，单实例 MVP 足够；多实例部署时再换共享存储。
 * now 可注入，便于测试。
 */
export interface RateLimitOptions {
  windowMs: number;
  max: number;
  keyFn?: (req: Request) => string;
  now?: () => number;
}

export function createRateLimit(options: RateLimitOptions) {
  const now = options.now ?? (() => Date.now());
  const buckets = new Map<string, { count: number; resetAt: number }>();

  return function rateLimit(req: Request, res: Response, next: NextFunction): void {
    const key = options.keyFn ? options.keyFn(req) : (req.ip ?? 'unknown');
    const current = now();
    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= current) {
      bucket = { count: 0, resetAt: current + options.windowMs };
      buckets.set(key, bucket);
    }
    bucket.count += 1;
    if (bucket.count > options.max) {
      const body: ApiErrorResponse = {
        error: ApiErrorCode.RateLimited,
        message: '操作太频繁，请稍后再试',
        requestId: typeof res.getHeader('X-Request-Id') === 'string' ? (res.getHeader('X-Request-Id') as string) : undefined,
      };
      res.status(429).json(body);
      return;
    }
    // 顺带清理过期桶，避免长期运行内存增长
    if (buckets.size > 1000) {
      for (const [k, v] of buckets) {
        if (v.resetAt <= current) buckets.delete(k);
      }
    }
    next();
  };
}
