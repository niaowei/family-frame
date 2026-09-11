import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { pingDatabase } from '../src/db/ping';
import { prisma } from '../src/db/prisma';

// M1 健康检查：不依赖 S3，sessionSecret 用测试值即可
const app = createApp({
  nodeEnv: 'test',
  sessionSecret: 'test-session-secret-0123456789abcdef',
  deviceTokenPepper: 'test-device-pepper-0123456789abcdef',
  prisma,
  s3: null,
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('GET /health', () => {
  it('returns 200 with process info', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(typeof res.body.app).toBe('string');
    expect(res.body.app.length).toBeGreaterThan(0);
    expect(typeof res.body.uptimeSeconds).toBe('number');
    expect(typeof res.body.timestamp).toBe('string');
    expect(Number.isNaN(Date.parse(res.body.timestamp as string))).toBe(false);
  });

  it('sets X-Request-Id header', async () => {
    const res = await request(app).get('/health');
    expect(res.headers['x-request-id']).toBeTruthy();
  });
});

describe('unknown route', () => {
  it('returns 404 JSON error without stack traces', async () => {
    const res = await request(app).get('/definitely/not/here');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('not_found');
    expect(res.text).not.toMatch(/at\s.+\(/); // 无堆栈
  });
});

describe('GET /health/db', () => {
  // 本测试不做任何 mock：先真实探测数据库连通性，再断言 /health/db 的响应与真实状态一致。
  // MySQL 在运行 → 期望 200/up；MySQL 不在 → 期望 503/down。两种情况都必须如实。
  it('reports the real database state', async () => {
    const actual = await pingDatabase();
    const res = await request(app).get('/health/db');

    if (actual.ok) {
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');
      expect(res.body.database).toBe('up');
      expect(typeof res.body.latencyMs).toBe('number');
    } else {
      expect(res.status).toBe(503);
      expect(res.body.status).toBe('error');
      expect(res.body.database).toBe('down');
      expect(typeof res.body.error).toBe('string');
    }
  }, 15000);
});
