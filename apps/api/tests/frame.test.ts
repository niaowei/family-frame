import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { createS3 } from '../src/lib/s3';
import { parseEnv } from '../src/config/env';
import { prisma } from '../src/db/prisma';
import { deviceTokenHash, generateDeviceToken } from '../src/auth/deviceToken';

/**
 * M3 frame API 集成测试（真实 MySQL）：
 * 设备 token 正确/错误、家庭隔离、feed 排序与游标、seen/heard 分离、心跳、媒体 302。
 */

const env = parseEnv(process.env as Record<string, string | undefined>);
const s3 = createS3(env.s3);
const PEPPER = 'test-device-pepper-0123456789abcdef';
const app = createApp({
  nodeEnv: 'test',
  sessionSecret: 'test-session-secret-0123456789abcdef',
  deviceTokenPepper: PEPPER,
  prisma,
  s3,
});

let familyAId = '';
let familyBId = '';
let tokenA = '';
let tokenB = '';
let deviceIdA = '';
let memberAId = '';
let oldestId = '';
let middleId = '';
let newestId = '';
let photoMediaId = '';
let bPostId = '';

beforeAll(async () => {
  const stamp = Date.now().toString(36);
  const rand = Math.floor(Math.random() * 1000);
  const familyA = await prisma.family.create({ data: { code: `FA${stamp}${rand}`, name: `FrameA-${stamp}` } });
  const familyB = await prisma.family.create({ data: { code: `FB${stamp}${rand}`, name: `FrameB-${stamp}` } });
  familyAId = familyA.id;
  familyBId = familyB.id;

  const memberA = await prisma.member.create({
    data: { familyId: familyAId, displayName: `发送者A${stamp}`, role: 'MEMBER', pinHash: 'scrypt$test' },
  });
  memberAId = memberA.id;
  const memberB = await prisma.member.create({
    data: { familyId: familyBId, displayName: `发送者B${stamp}`, role: 'MEMBER', pinHash: 'scrypt$test' },
  });

  tokenA = generateDeviceToken();
  tokenB = generateDeviceToken();
  const deviceA = await prisma.device.create({
    data: { familyId: familyAId, name: '测试相框A', tokenHash: deviceTokenHash(tokenA, PEPPER) },
  });
  await prisma.device.create({
    data: { familyId: familyBId, name: '测试相框B', tokenHash: deviceTokenHash(tokenB, PEPPER) },
  });
  deviceIdA = deviceA.id;

  const base = Date.parse('2026-09-01T10:00:00Z');
  const oldest = await prisma.post.create({
    data: { familyId: familyAId, memberId: memberAId, messageText: '最早的照片', createdAt: new Date(base) },
  });
  const middle = await prisma.post.create({
    data: { familyId: familyAId, memberId: memberAId, messageText: '中间的照片', createdAt: new Date(base + 60_000) },
  });
  const newest = await prisma.post.create({
    data: { familyId: familyAId, memberId: memberAId, messageText: '最新的照片', createdAt: new Date(base + 120_000) },
  });
  const photo = await prisma.media.create({
    data: {
      postId: middle.id,
      type: 'PHOTO',
      objectKey: `families/${familyAId}/posts/${middle.id}/photo-test.png`,
      mimeType: 'image/png',
      width: 100,
      height: 100,
    },
  });
  await prisma.media.create({
    data: {
      postId: newest.id,
      type: 'VOICE',
      objectKey: `families/${familyAId}/posts/${newest.id}/voice-test.webm`,
      mimeType: 'audio/webm',
      durationMs: 8000,
    },
  });
  oldestId = oldest.id;
  middleId = middle.id;
  newestId = newest.id;
  photoMediaId = photo.id;

  const bPost = await prisma.post.create({
    data: { familyId: familyBId, memberId: memberB.id, messageText: 'B 家庭的内容', createdAt: new Date(base) },
  });
  bPostId = bPost.id;
});

afterAll(async () => {
  await prisma.family.delete({ where: { id: familyAId } }).catch(() => undefined);
  await prisma.family.delete({ where: { id: familyBId } }).catch(() => undefined);
  await prisma.$disconnect();
});

const auth = (t: string) => ({ 'x-device-token': t });

describe('设备 token 鉴权', () => {
  it('正确 token 拉取 feed 成功，且响应不含 objectKey', async () => {
    const res = await request(app).get('/api/frame/feed').set(auth(tokenA));
    expect(res.status).toBe(200);
    expect(res.body.posts).toHaveLength(3);
    expect(res.body.cursor).toBe(newestId);
    expect(typeof res.body.serverTime).toBe('string');
    expect(JSON.stringify(res.body)).not.toContain('objectKey');
    expect(JSON.stringify(res.body)).not.toContain('photo-test.png');
  });

  it('错误 token → 401 设备令牌无效', async () => {
    const res = await request(app).get('/api/frame/feed').set(auth('wrong-token-value'));
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('unauthorized');
    expect(res.body.message).toBe('设备令牌无效');
  });

  it('缺少 token 头 → 401 设备未认证', async () => {
    const res = await request(app).get('/api/frame/feed');
    expect(res.status).toBe(401);
    expect(res.body.message).toBe('设备未认证');
  });

  it('不同家庭的设备互相隔离：A 看不到 B，B 看不到 A', async () => {
    const feedA = await request(app).get('/api/frame/feed').set(auth(tokenA));
    expect(feedA.body.posts.some((p: { id: string }) => p.id === bPostId)).toBe(false);

    const feedB = await request(app).get('/api/frame/feed').set(auth(tokenB));
    expect(feedB.status).toBe(200);
    expect(feedB.body.posts).toHaveLength(1);
    expect(feedB.body.posts[0].id).toBe(bPostId);
  });
});

describe('feed 排序与游标', () => {
  it('createdAt 倒序：最新在前', async () => {
    const res = await request(app).get('/api/frame/feed').set(auth(tokenA));
    const ids = res.body.posts.map((p: { id: string }) => p.id);
    expect(ids).toEqual([newestId, middleId, oldestId]);
  });

  it('after 游标只返回更新的内容', async () => {
    const res = await request(app).get('/api/frame/feed').set(auth(tokenA)).query({ after: middleId });
    expect(res.status).toBe(200);
    expect(res.body.posts.map((p: { id: string }) => p.id)).toEqual([newestId]);
  });

  it('limit 限制条数（MVP ≤ 50）', async () => {
    const res = await request(app).get('/api/frame/feed').set(auth(tokenA)).query({ limit: 2 });
    expect(res.body.posts).toHaveLength(2);
    expect(res.body.posts.map((p: { id: string }) => p.id)).toEqual([newestId, middleId]);
  });

  it('无效 after → 400', async () => {
    const res = await request(app)
      .get('/api/frame/feed')
      .set(auth(tokenA))
      .query({ after: 'nonexistent-cursor' });
    expect(res.status).toBe(400);
  });

  it('before 游标只返回更旧的内容', async () => {
    const res = await request(app).get('/api/frame/feed').set(auth(tokenA)).query({ before: middleId });
    expect(res.status).toBe(200);
    expect(res.body.posts.map((p: { id: string }) => p.id)).toEqual([oldestId]);
  });

  it('before 与 after 同时使用 → 400', async () => {
    const res = await request(app)
      .get('/api/frame/feed')
      .set(auth(tokenA))
      .query({ before: middleId, after: oldestId });
    expect(res.status).toBe(400);
  });

  it('向后分页不漏第 51 条：整页取满继续，直到不满页', async () => {
    // A2 家庭 51 条 post，limit=25：第 1 页 25 条（满页）→ 第 2 页 25 条（满页）→ 第 3 页 1 条
    const stamp = Date.now().toString(36);
    const familyP = await prisma.family.create({ data: { code: `FP${stamp}`, name: `FrameP-${stamp}` } });
    const memberP = await prisma.member.create({
      data: { familyId: familyP.id, displayName: `发送者P${stamp}`, role: 'MEMBER', pinHash: 'scrypt$test' },
    });
    const tokenP = generateDeviceToken();
    await prisma.device.create({
      data: { familyId: familyP.id, name: '分页相框', tokenHash: deviceTokenHash(tokenP, PEPPER) },
    });
    const base = Date.parse('2026-09-02T10:00:00Z');
    const ids: string[] = [];
    for (let i = 0; i < 51; i++) {
      const p = await prisma.post.create({
        data: { familyId: familyP.id, memberId: memberP.id, messageText: `第${i + 1}张`, createdAt: new Date(base + i * 60_000) },
      });
      ids.push(p.id);
    }
    try {
      const seen = new Set<string>();
      let before: string | undefined;
      for (let page = 0; page < 10; page++) {
        const res = await request(app)
          .get('/api/frame/feed')
          .set(auth(tokenP))
          .query({ limit: 25, ...(before ? { before } : {}) });
        expect(res.status).toBe(200);
        const posts = res.body.posts as { id: string }[];
        expect(posts.length).toBeGreaterThan(0);
        for (const p of posts) seen.add(p.id);
        if (posts.length < 25) break;
        before = posts[posts.length - 1]!.id;
      }
      expect(seen.size).toBe(51);
      for (const id of ids) expect(seen.has(id)).toBe(true);
    } finally {
      await prisma.family.delete({ where: { id: familyP.id } }).catch(() => undefined);
    }
  });
});

describe('seen / heard 分离（PRD §6）', () => {
  it('seen 写入 firstSeenAt，重复上报不覆盖', async () => {
    const first = await request(app).post(`/api/frame/posts/${middleId}/seen`).set(auth(tokenA));
    expect(first.status).toBe(200);
    const row1 = await prisma.deviceRead.findUnique({
      where: { deviceId_postId: { deviceId: deviceIdA, postId: middleId } },
    });
    expect(row1?.firstSeenAt).not.toBeNull();
    expect(row1?.heardAt).toBeNull();

    await new Promise((r) => setTimeout(r, 20));
    await request(app).post(`/api/frame/posts/${middleId}/seen`).set(auth(tokenA));
    const row2 = await prisma.deviceRead.findUnique({
      where: { deviceId_postId: { deviceId: deviceIdA, postId: middleId } },
    });
    expect(row2?.firstSeenAt?.getTime()).toBe(row1?.firstSeenAt?.getTime());
  });

  it('heard 单独写入 heardAt，seen 不覆盖 heardAt', async () => {
    await request(app).post(`/api/frame/posts/${newestId}/heard`).set(auth(tokenA));
    const row1 = await prisma.deviceRead.findUnique({
      where: { deviceId_postId: { deviceId: deviceIdA, postId: newestId } },
    });
    expect(row1?.heardAt).not.toBeNull();
    expect(row1?.firstSeenAt).toBeNull();

    const heardAt = row1?.heardAt?.getTime();
    await request(app).post(`/api/frame/posts/${newestId}/seen`).set(auth(tokenA));
    const row2 = await prisma.deviceRead.findUnique({
      where: { deviceId_postId: { deviceId: deviceIdA, postId: newestId } },
    });
    expect(row2?.firstSeenAt).not.toBeNull();
    expect(row2?.heardAt?.getTime()).toBe(heardAt);
  });

  it('跨家庭 post 的 seen/heard → 404', async () => {
    const seen = await request(app).post(`/api/frame/posts/${bPostId}/seen`).set(auth(tokenA));
    expect(seen.status).toBe(404);
    const heard = await request(app).post(`/api/frame/posts/${bPostId}/heard`).set(auth(tokenA));
    expect(heard.status).toBe(404);
    const row = await prisma.deviceRead.findUnique({
      where: { deviceId_postId: { deviceId: deviceIdA, postId: bPostId } },
    });
    expect(row).toBeNull();
  });
});

describe('心跳（PRD §14）', () => {
  it('更新 lastSeenAt 与 appVersion；上报内容可缺省', async () => {
    const before = await prisma.device.findUnique({ where: { id: deviceIdA } });
    await new Promise((r) => setTimeout(r, 20));
    const res = await request(app)
      .post('/api/frame/heartbeat')
      .set(auth(tokenA))
      .send({ appVersion: '0.1.0-web', clientTime: '2026-09-06T00:00:00Z', cacheCount: 0 });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    const after = await prisma.device.findUnique({ where: { id: deviceIdA } });
    expect(after?.lastSeenAt?.getTime() ?? 0).toBeGreaterThan(before?.lastSeenAt?.getTime() ?? 0);
    expect(after?.appVersion).toBe('0.1.0-web');

    const empty = await request(app).post('/api/frame/heartbeat').set(auth(tokenA)).send({});
    expect(empty.status).toBe(200);
  });
});

describe('相框媒体访问', () => {
  it('302 到预签名 URL，不直接暴露 objectKey', async () => {
    const res = await request(app).get(`/api/frame/media/${photoMediaId}`).set(auth(tokenA));
    expect(res.status).toBe(302);
    const location = res.headers.location as string;
    expect(location).toContain('X-Amz-Signature');
  });

  it('其他家庭媒体 → 404', async () => {
    // B 家庭设备访问 A 家庭的媒体
    const res = await request(app).get(`/api/frame/media/${photoMediaId}`).set(auth(tokenB));
    expect(res.status).toBe(404);
  });
});
