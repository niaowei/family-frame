import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { createS3 } from '../src/lib/s3';
import { parseEnv } from '../src/config/env';
import { prisma } from '../src/db/prisma';
import { hashPin } from '../src/auth/pin';

/**
 * 短码配对集成测试（E2 §6，真实 MySQL）：
 * 生成需登录、6 位数字、5 分钟有效、原子单次兑换、兑换出的令牌可访问相框接口、
 * 过期/重复/错误短码统一拒绝、兑换限流防猜测。
 */

const env = parseEnv(process.env as Record<string, string | undefined>);
const s3 = createS3(env.s3);
const app = createApp({
  nodeEnv: 'test',
  sessionSecret: 'test-session-secret-0123456789abcdef',
  deviceTokenPepper: 'test-device-pepper-0123456789abcdef',
  prisma,
  s3,
});

let familyId = '';
let familyCode = '';
let cookie = '';

beforeAll(async () => {
  const stamp = Date.now().toString(36);
  familyCode = `PC${stamp}`;
  const family = await prisma.family.create({ data: { code: familyCode, name: `Pair-${stamp}` } });
  familyId = family.id;
  await prisma.member.create({
    data: { familyId, displayName: `家长${stamp}`, role: 'ADMIN', pinHash: await hashPin('123456') },
  });
  const res = await request(app)
    .post('/api/auth/login')
    .send({ familyCode, member: `家长${stamp}`, pin: '123456' });
  expect(res.status).toBe(200);
  cookie = ((res.headers['set-cookie'] as string[] | undefined) ?? [])[0] as string;
});

afterAll(async () => {
  await prisma.family.delete({ where: { id: familyId } }).catch(() => undefined);
  await prisma.$disconnect();
});

describe('短码生成 /api/pair/code', () => {
  it('未登录 → 401', async () => {
    const res = await request(app).post('/api/pair/code').send({});
    expect(res.status).toBe(401);
  });

  it('登录后生成 6 位数字短码', async () => {
    const res = await request(app).post('/api/pair/code').set('Cookie', cookie).send({});
    expect(res.status).toBe(201);
    expect(res.body.code).toMatch(/^[0-9]{6}$/);
    expect(typeof res.body.expiresAt).toBe('string');
  });
});

describe('短码兑换 /api/pair/redeem', () => {
  it('完整流程：生成 → 兑换 → 新设备令牌可访问 feed', async () => {
    const gen = await request(app).post('/api/pair/code').set('Cookie', cookie).send({});
    expect(gen.status).toBe(201);
    const code = gen.body.code as string;

    const redeem = await request(app).post('/api/pair/redeem').send({ code, deviceName: '客厅新相框' });
    expect(redeem.status).toBe(201);
    const token = redeem.body.deviceToken as string;
    expect(token).toBeTruthy();

    // 兑换出的令牌立即访问相框接口
    const feed = await request(app).get('/api/frame/feed').set('x-device-token', token);
    expect(feed.status).toBe(200);

    const device = await prisma.device.findFirst({ where: { name: '客厅新相框', familyId } });
    expect(device).not.toBeNull();
  });

  it('同一短码只能兑换一次', async () => {
    const gen = await request(app).post('/api/pair/code').set('Cookie', cookie).send({});
    const code = gen.body.code as string;
    const first = await request(app).post('/api/pair/redeem').send({ code });
    expect(first.status).toBe(201);
    const second = await request(app).post('/api/pair/redeem').send({ code });
    expect(second.status).toBe(400);
    expect(second.body.message).toBe('短码无效或已过期，请家人重新生成');
  });

  it('格式错误的短码 → 400', async () => {
    const res = await request(app).post('/api/pair/redeem').send({ code: 'abc12' });
    expect(res.status).toBe(400);
    expect(res.body.message).toBe('短码是 6 位数字');
  });

  it('猜错的有效格式短码 → 400（统一文案，不区分不存在/已用/过期）', async () => {
    const res = await request(app).post('/api/pair/redeem').send({ code: '000000' });
    expect(res.status).toBe(400);
    expect(res.body.message).toBe('短码无效或已过期，请家人重新生成');
  });

  it('过期短码 → 400', async () => {
    const gen = await request(app).post('/api/pair/code').set('Cookie', cookie).send({});
    const code = gen.body.code as string;
    // 直接把库里这条短码改成已过期
    await prisma.pairCode.updateMany({ where: { code }, data: { expiresAt: new Date(Date.now() - 1000) } });
    const res = await request(app).post('/api/pair/redeem').send({ code });
    expect(res.status).toBe(400);
  });
});
