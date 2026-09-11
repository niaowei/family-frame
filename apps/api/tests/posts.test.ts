import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { createS3 } from '../src/lib/s3';
import { parseEnv } from '../src/config/env';
import { prisma } from '../src/db/prisma';
import { hashPin } from '../src/auth/pin';

/**
 * M2 核心链路集成测试（真实 MySQL + 真实 MinIO，无 mock）：
 * presign → 直传 S3 → create post（校验+搬移对象+落库）→ history → 媒体访问 → 删除。
 * MinIO 不可用时会明确跳过（不做假通过）。
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

let s3Available = false;
let familyId = '';
let adminCookie = '';
let memberCookie = '';

// 1×1 真实 PNG
const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
// 最小可嗅探 JPEG 头
const JPEG_BYTES = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32, 0x11)]);
const TEXT_BYTES = Buffer.from('this is definitely not an image');

async function loginAs(displayName: string): Promise<string> {
  const res = await request(app)
    .post('/api/auth/login')
    .send({ familyCode: familyCodeValue, member: displayName, pin: '123456' });
  expect(res.status).toBe(200);
  const cookie = ((res.headers['set-cookie'] as string[] | undefined) ?? [])[0] as string;
  expect(cookie).toBeTruthy();
  return cookie;
}

async function uploadObject(
  cookie: string,
  type: 'photo' | 'voice',
  mimeType: string,
  bytes: Buffer,
  declaredSize?: number,
): Promise<string> {
  const presign = await request(app)
    .post('/api/uploads/presign')
    .set('Cookie', cookie)
    .send({ type, mimeType, size: declaredSize ?? bytes.length });
  expect(presign.status).toBe(200);
  const put = await fetch(presign.body.uploadUrl, {
    method: 'PUT',
    headers: presign.body.headers,
    body: new Uint8Array(bytes),
  });
  expect(put.ok).toBe(true);
  return presign.body.key as string;
}

let familyCodeValue = '';

// MinIO 可用性必须在 describe 定义前确定（runIf/skipIf 在模块加载时求值），
// 因此探测放在模块顶层而不是 beforeAll。
if (s3) {
  try {
    await s3.headObject(`families/none/staging/probe-${Date.now()}.bin`);
    // headObject 对 404 返回 null（对象不存在但服务可达）
    s3Available = true;
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === 'ENOTFOUND' || code === 'ECONNREFUSED' || code === 'EAI_AGAIN') {
      s3Available = false;
    } else {
      throw err;
    }
  }
}

beforeAll(async () => {
  // 每次测试运行创建独立的家庭/成员，避免依赖 seed
  const stamp = Date.now().toString(36);
  familyCodeValue = `T${stamp}${Math.floor(Math.random() * 1000)}`;
  const family = await prisma.family.create({
    data: { code: familyCodeValue, name: `测试家庭-${stamp}` },
  });
  familyId = family.id;
  await prisma.member.create({
    data: { familyId, displayName: `管理员${stamp}`, role: 'ADMIN', pinHash: await hashPin('123456') },
  });
  await prisma.member.create({
    data: { familyId, displayName: `成员${stamp}`, role: 'MEMBER', pinHash: await hashPin('123456') },
  });

  if (s3Available) {
    adminCookie = await loginAs(`管理员${stamp}`);
    memberCookie = await loginAs(`成员${stamp}`);
  }
}, 30000);

afterAll(async () => {
  // 清理测试家庭的数据（级联删除 post/media/device_reads）
  if (familyId) {
    await prisma.family.delete({ where: { id: familyId } }).catch(() => undefined);
  }
  await prisma.$disconnect();
});

describe.runIf(s3Available)('M2 上传链路（真实 MinIO + MySQL）', () => {
  it('登录后 presign → 直传 → create post → 对象被搬到最终 key', async () => {
    const key = await uploadObject(adminCookie, 'photo', 'image/png', PNG_BYTES);
    expect(key).toContain(`families/${familyId}/staging/`);

    const created = await request(app)
      .post('/api/posts')
      .set('Cookie', adminCookie)
      .send({
        messageText: '  奶奶，这是我今天出去玩的照片。  ',
        photoKeys: [key],
        photoMeta: { [key]: { width: 1, height: 1 } },
      });
    expect(created.status).toBe(201);
    const postId = created.body.post.id as string;

    // 数据库：留言已 trim；media 指向最终 key（PRD §10：families/{fid}/posts/{pid}/photo-*.png）
    const post = await prisma.post.findUnique({
      where: { id: postId },
      include: { media: true },
    });
    expect(post).not.toBeNull();
    expect(post?.messageText).toBe('奶奶，这是我今天出去玩的照片。');
    expect(post?.media).toHaveLength(1);
    expect(post?.media[0]?.objectKey).toContain(`families/${familyId}/posts/${postId}/photo-`);
    expect(post?.media[0]?.type).toBe('PHOTO');
    expect(post?.media[0]?.mimeType).toBe('image/png');

    // 对象存储：最终 key 存在、staging 已清理
    const finalKey = post?.media[0]?.objectKey ?? '';
    const finalHead = await s3?.headObject(finalKey);
    expect(finalHead?.size).toBe(PNG_BYTES.length);
    expect(await s3?.headObject(key)).toBeNull();
  }, 30000);

  it('真人语音：WebM 录音直传并随 post 保存（durationMs 落库）', async () => {
    const webm = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(64, 0x42)]);
    const key = await uploadObject(memberCookie, 'voice', 'audio/webm', webm);

    const photoKey = await uploadObject(memberCookie, 'photo', 'image/jpeg', JPEG_BYTES);
    const created = await request(app)
      .post('/api/posts')
      .set('Cookie', memberCookie)
      .send({
        messageText: '听听我的声音',
        photoKeys: [photoKey],
        voiceKey: key,
        voiceDurationMs: 12000,
      });
    expect(created.status).toBe(201);

    const post = await prisma.post.findUnique({
      where: { id: created.body.post.id },
      include: { media: true },
    });
    const voiceMedia = post?.media.find((m) => m.type === 'VOICE');
    expect(voiceMedia).toBeDefined();
    expect(voiceMedia?.objectKey).toContain(`families/${familyId}/posts/${post?.id}/voice-`);
    expect(voiceMedia?.durationMs).toBe(12000);
  }, 30000);

  it('history 列表返回最近内容且不带 objectKey', async () => {
    const res = await request(app).get('/api/posts').set('Cookie', memberCookie);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.posts)).toBe(true);
    expect(res.body.posts.length).toBeGreaterThan(0);
    const first = res.body.posts[0];
    expect(first.member.displayName).toBeTruthy();
    expect(first.media[0].id).toBeTruthy();
    expect(JSON.stringify(first)).not.toContain('staging');
  });

  it('媒体访问：302 到预签名 URL，跟随访问取回真实字节', async () => {
    const list = await request(app).get('/api/posts').set('Cookie', memberCookie);
    const mediaId = list.body.posts[0].media[0].id as string;

    const redirect = await request(app).get(`/api/media/${mediaId}`).set('Cookie', memberCookie);
    expect(redirect.status).toBe(302);
    const location = redirect.headers.location as string;
    expect(location).toContain('X-Amz-Signature');

    const obj = await fetch(location);
    expect(obj.ok).toBe(true);
    const bytes = Buffer.from(await obj.arrayBuffer());
    expect(bytes.length).toBeGreaterThan(0);
    // 取回的字节必须是真实图片：PNG (89) 或 JPEG (FF D8)
    expect([0x89, 0xff].some((magic) => bytes[0] === magic)).toBe(true);
  });

  it('跨家庭 key 拒绝（PRD §16 防任意上传）', async () => {
    const res = await request(app)
      .post('/api/posts')
      .set('Cookie', memberCookie)
      .send({ messageText: 'x', photoKeys: ['families/OTHER/staging/evil.png'] });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('bad_request');
  });

  it('未上传的 key 拒绝', async () => {
    const res = await request(app)
      .post('/api/posts')
      .set('Cookie', memberCookie)
      .send({
        messageText: 'x',
        photoKeys: [`families/${familyId}/staging/never-uploaded-${Date.now()}.png`],
      });
    expect(res.status).toBe(400);
  });

  it('伪装成图片的文本文件拒绝（魔数嗅探）', async () => {
    const key = await uploadObject(memberCookie, 'photo', 'image/png', TEXT_BYTES);
    const res = await request(app)
      .post('/api/posts')
      .set('Cookie', memberCookie)
      .send({ messageText: 'x', photoKeys: [key] });
    expect(res.status).toBe(400);
    expect(res.body.message).toContain('不是有效的图片');
  });

  it('超大照片拒绝：presign 声明合法大小、实际上传超限对象，以 S3 真实 ContentLength 为准', async () => {
    const before = await prisma.post.count({ where: { familyId } });
    // 声明为合法小图（presign 可通过），实际 PUT 9MB（> 照片上限 8MB），开头带 PNG 魔数
    const oversize = Buffer.concat([PNG_BYTES.subarray(0, 8), Buffer.alloc(9 * 1024 * 1024)]);
    const key = await uploadObject(memberCookie, 'photo', 'image/png', oversize, PNG_BYTES.length);

    const res = await request(app)
      .post('/api/posts')
      .set('Cookie', memberCookie)
      .send({ messageText: '大文件', photoKeys: [key] });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('bad_request');

    // 数据库不留任何 Post / Media 状态
    expect(await prisma.post.count({ where: { familyId } })).toBe(before);
    // staging 对象已被尽量清理
    expect(await s3?.headObject(key)).toBeNull();
  }, 60000);

  it('超大语音拒绝：真实 ContentLength 超过语音上限（5MB）同样被拒且不留状态', async () => {
    const before = await prisma.post.count({ where: { familyId } });
    // 声明合法小语音，实际上传 6MB（> 语音上限 5MB），开头带 WebM 魔数
    const oversizeVoice = Buffer.concat([
      Buffer.from([0x1a, 0x45, 0xdf, 0xa3]),
      Buffer.alloc(6 * 1024 * 1024),
    ]);
    const voiceKey = await uploadObject(
      memberCookie,
      'voice',
      'audio/webm',
      oversizeVoice,
      4096,
    );
    const photoKey = await uploadObject(memberCookie, 'photo', 'image/png', PNG_BYTES);

    const res = await request(app)
      .post('/api/posts')
      .set('Cookie', memberCookie)
      .send({ messageText: '大语音', photoKeys: [photoKey], voiceKey });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('bad_request');

    expect(await prisma.post.count({ where: { familyId } })).toBe(before);
    expect(await s3?.headObject(voiceKey)).toBeNull();
    // 照片本身合规，但请求被整体拒绝，其 staging 也一并清理
    expect(await s3?.headObject(photoKey)).toBeNull();
  }, 60000);

  it('create post 校验：0 张 / 超过 9 张 / 留言超 80 字', async () => {
    const noPhotos = await request(app)
      .post('/api/posts')
      .set('Cookie', memberCookie)
      .send({ messageText: 'x', photoKeys: [] });
    expect(noPhotos.status).toBe(400);

    const tooManyKeys = Array.from({ length: 10 }, (_, i) => `families/${familyId}/staging/k${i}.png`);
    const tooMany = await request(app)
      .post('/api/posts')
      .set('Cookie', memberCookie)
      .send({ messageText: 'x', photoKeys: tooManyKeys });
    expect(tooMany.status).toBe(400);

    const long = await request(app)
      .post('/api/posts')
      .set('Cookie', memberCookie)
      .send({ messageText: '好'.repeat(81), photoKeys: [`families/${familyId}/staging/x.png`] });
    expect(long.status).toBe(400);
  });

  it('未登录访问业务接口返回 401', async () => {
    expect((await request(app).get('/api/posts')).status).toBe(401);
    expect(
      (await request(app).post('/api/uploads/presign').send({ type: 'photo', mimeType: 'image/png', size: 1 }))
        .status,
    ).toBe(401);
    expect(
      (await request(app).post('/api/posts').send({ messageText: 'x', photoKeys: ['a'] })).status,
    ).toBe(401);
  });

  it('删除：管理员可删任意内容；普通成员删除他人内容被拒；删除后列表不再出现', async () => {
    const key = await uploadObject(adminCookie, 'photo', 'image/png', PNG_BYTES);
    const created = await request(app)
      .post('/api/posts')
      .set('Cookie', adminCookie)
      .send({ messageText: '待删除', photoKeys: [key] });
    const postId = created.body.post.id as string;

    // 普通成员（默认配置 memberCanDeleteOwnPost=false，且这是别人的内容）→ 403
    const forbidden = await request(app).delete(`/api/posts/${postId}`).set('Cookie', memberCookie);
    expect(forbidden.status).toBe(403);

    // 管理员 → 200
    const ok = await request(app).delete(`/api/posts/${postId}`).set('Cookie', adminCookie);
    expect(ok.status).toBe(200);

    // 列表不再出现
    const list = await request(app).get('/api/posts').set('Cookie', adminCookie);
    expect(list.body.posts.some((p: { id: string }) => p.id === postId)).toBe(false);
  }, 30000);
});

describe.skipIf(s3Available)('M2 上传链路', () => {
  it('MinIO 不可达，集成套件跳过（明确说明，不假通过）', () => {
    console.warn('MinIO 未运行（docker compose up -d 后再跑测试），上传链路集成测试已跳过');
    expect(s3Available).toBe(false);
  });
});
