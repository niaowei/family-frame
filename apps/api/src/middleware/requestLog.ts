import crypto from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

/**
 * 请求日志（PRD §20）：只记录 requestId、method、route、status、duration。
 * 不记录任何 header / token / 密钥。
 */
export function requestLog(req: Request, res: Response, next: NextFunction): void {
  const startedAt = performance.now();
  const requestId = crypto.randomUUID();
  const route = req.path.replace(/\/(api\/auth\/invitation|join)\/[^/]+/, '/$1/[redacted]');
  res.setHeader('X-Request-Id', requestId);

  res.on('finish', () => {
    const durationMs = Math.round(performance.now() - startedAt);
    console.log(
      JSON.stringify({
        requestId,
        method: req.method,
        route,
        status: res.statusCode,
        durationMs,
      }),
    );
  });

  next();
}
