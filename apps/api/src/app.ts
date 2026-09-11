import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import cookieParser from 'cookie-parser';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { ApiErrorCode } from '@family-frame/shared';
import type { ApiErrorResponse } from '@family-frame/shared';
import { requestLog } from './middleware/requestLog';
import { createRateLimit } from './middleware/rateLimit';
import { requireMember as createRequireMember } from './auth/requireMember';
import { requireDevice as createRequireDevice } from './auth/requireDevice';
import { frameRouter } from './routes/frame';
import { healthRouter } from './routes/health';
import { authRouter } from './routes/auth';
import { uploadsRouter } from './routes/uploads';
import { postsRouter } from './routes/posts';
import { mediaRouter } from './routes/media';
import { pairRouter } from './routes/pair';
import { familyRouter } from './routes/family';
import type { NodeEnv } from './config/env';
import type { S3Service } from './lib/s3';
import type { PrismaClient } from '@prisma/client';

export interface AppOptions {
  nodeEnv: NodeEnv;
  sessionSecret: string;
  deviceTokenPepper: string;
  prisma: PrismaClient;
  s3: S3Service | null;
  /** 生产静态托管目录（apps/web/dist）；为空则仅提供 API */
  webDistDir?: string | null;
}

export function createApp(options: AppOptions): express.Express {
  const app = express();
  const { prisma, s3 } = options;
  const nodeEnv = options.nodeEnv;

  app.disable('x-powered-by');
  // Sealos 公网入口在反向代理之后：信任一层代理，确保 HTTPS/Secure cookie 与客户端 IP 识别正确
  app.set('trust proxy', nodeEnv === 'production' ? 1 : false);
  app.use(requestLog);
  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());
  app.use((_req, res, next) => { res.setHeader('Referrer-Policy', 'no-referrer'); next(); });

  // 限流（PRD §16）：登录按 IP，业务操作按成员
  const loginRateLimit = createRateLimit({ windowMs: 60_000, max: 20 });
  const presignRateLimit = createRateLimit({
    windowMs: 60_000,
    max: 60,
    keyFn: (req) => `member:${req.member?.id ?? req.ip ?? 'unknown'}`,
  });
  const postsRateLimit = createRateLimit({
    windowMs: 60_000,
    max: 60,
    keyFn: (req) => `member:${req.member?.id ?? req.ip ?? 'unknown'}`,
  });
  const frameRateLimit = createRateLimit({
    windowMs: 60_000,
    max: 120,
    keyFn: (req) => `device:${req.device?.id ?? req.ip ?? 'unknown'}`,
  });
  // 短码配对：生成按成员；兑换按 IP 防猜测（10 次/5 分钟）
  const pairCodeRateLimit = createRateLimit({
    windowMs: 60_000,
    max: 10,
    keyFn: (req) => `member:${req.member?.id ?? req.ip ?? 'unknown'}`,
  });
  const pairRedeemRateLimit = createRateLimit({ windowMs: 5 * 60_000, max: 10 });

  app.use(healthRouter());
  const requireMember = createRequireMember(prisma, options.sessionSecret, nodeEnv === 'production');
  app.use(authRouter({ prisma, sessionSecret: options.sessionSecret, isProduction: nodeEnv === 'production', loginRateLimit, requireMember }));
  const familyLimit = createRateLimit({ windowMs: 15 * 60_000, max: 10, keyFn: (req) => req.member!.id });
  app.use('/api/family', requireMember, (req, res, next) => req.method === 'GET' ? next() : familyLimit(req, res, next), familyRouter(prisma));

  // 以下路由要求登录（requireMember 在各 router 内部第一个挂载点统一执行）
  app.use('/api/uploads', requireMember, uploadsRouter({ s3, presignRateLimit }));
  app.use('/api/posts', requireMember, postsRouter({ prisma, s3, postsRateLimit }));
  app.use('/api/media', requireMember, mediaRouter({ prisma, s3 }));
  const requireDevice = createRequireDevice(prisma, options.deviceTokenPepper);
  app.use('/api/frame', requireDevice, frameRouter({ prisma, s3, frameRateLimit }));

  // 短码配对：/code 需成员登录；/redeem 公开（限流防猜测）
  app.use('/api/pair', pairRouter({
    prisma,
    deviceTokenPepper: options.deviceTokenPepper,
    requireMember,
    codeRateLimit: pairCodeRateLimit,
    redeemRateLimit: pairRedeemRateLimit,
  }));

  // 生产模式：单 Origin 同时提供 /api 与 Web 构建产物（PRD M5 §一）
  const webDistDir = options.webDistDir;
  if (webDistDir && existsSync(path.join(webDistDir, 'index.html'))) {
    app.use(
      express.static(webDistDir, {
        setHeaders: (res, filePath) => {
          if (filePath.includes(`${path.sep}assets${path.sep}`)) {
            // hashed 资源内容不可变：长缓存
            res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
          } else if (filePath.endsWith('sw.js') || filePath.endsWith('index.html')) {
            // SW 与入口 HTML 必须每次校验，保证更新可达且不被长期缓存
            res.setHeader('Cache-Control', 'no-cache');
          }
        },
      }),
    );
    // SPA history fallback：仅 GET + HTML；/api、/health、/sw.js 与真实静态文件不受影响
    app.use((req: Request, res: Response, next: NextFunction) => {
      if (req.method !== 'GET' || !req.accepts('html')) return next();
      const p = req.path;
      if (p.startsWith('/api/') || p.startsWith('/health') || p === '/sw.js') return next();
      res.setHeader('Cache-Control', 'no-cache');
      res.sendFile(path.join(webDistDir, 'index.html'));
    });
  }

  // 404：统一 JSON，不暴露路由表以外的信息
  app.use((req: Request, res: Response) => {
    const body: ApiErrorResponse = {
      error: ApiErrorCode.NotFound,
      message: `route ${req.method} ${req.path} not found`,
    };
    res.status(404).json(body);
  });

  // 统一错误处理：不向客户端返回 stack / 内部细节（PRD §19 错误策略的服务端侧）
  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    const requestId = res.getHeader('X-Request-Id');
    console.error(
      JSON.stringify({
        requestId: typeof requestId === 'string' ? requestId : undefined,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    const body: ApiErrorResponse = {
      error: ApiErrorCode.InternalError,
      requestId: typeof requestId === 'string' ? requestId : undefined,
    };
    res.status(500).json(body);
  });

  return app;
}
