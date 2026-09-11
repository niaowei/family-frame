import { Router } from 'express';
import { APP_NAME, APP_VERSION } from '@family-frame/shared';
import type { HealthDbResponse, HealthResponse } from '@family-frame/shared';
import { pingDatabase } from '../db/ping';

export function healthRouter(): Router {
  const router = Router();

  // 进程级健康检查：不依赖数据库，永远反映进程本身状态（PRD M5 §二十三：可暴露 appVersion，不含 secret）
  router.get('/health', (_req, res) => {
    const body: HealthResponse = {
      status: 'ok',
      app: APP_NAME,
      version: APP_VERSION,
      uptimeSeconds: Math.round(process.uptime()),
      timestamp: new Date().toISOString(),
    };
    res.json(body);
  });

  // 数据库连通性检查（管理员诊断用）：真实执行 SELECT 1，数据库不可达时如实返回 503
  router.get('/health/db', async (_req, res, next) => {
    try {
      const ping = await pingDatabase();
      const body: HealthDbResponse = ping.ok
        ? { status: 'ok', database: 'up', latencyMs: ping.latencyMs }
        : { status: 'error', database: 'down', latencyMs: null, error: ping.error };
      res.status(ping.ok ? 200 : 503).json(body);
    } catch (err) {
      next(err);
    }
  });

  return router;
}
