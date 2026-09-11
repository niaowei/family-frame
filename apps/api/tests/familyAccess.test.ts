import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { createApp } from '../src/app';
import { hashPin, verifyPin } from '../src/auth/pin';
import { SESSION_TTL_SECONDS, signSession, verifySession } from '../src/auth/session';
import { invitationHash } from '../src/routes/auth';
import { deviceTokenHash } from '../src/auth/deviceToken';

// HTTP/权限契约测试，数据库边界使用替身；MySQL 事务与迁移另由集成测试验证。
const secret = 'family-access-test-secret-only';
const pepper = 'family-access-device-pepper-only';
const family = { id: 'family-a', code: 'family-entry-a', name: '测试家庭' };
const inviteToken = 'a'.repeat(64);
const member = { id: 'member-a', familyId: family.id, displayName: '小明', role: 'MEMBER' as const, pinHash: '', sessionVersion: 0 };
const admin = { ...member, id: 'admin-a', displayName: '家长', role: 'ADMIN' as const };
const cookie = (person: Omit<typeof member, 'role'> & { role: 'ADMIN' | 'MEMBER' } = member, ageSeconds = 0) => `ff_session=${signSession({ memberId: person.id, familyId: person.familyId, role: person.role, sessionVersion: person.sessionVersion }, secret, Math.floor(Date.now() / 1000) - ageSeconds)}`;
const cookieToken = (res: request.Response): string => String(res.headers['set-cookie']?.[0]).split(';')[0]!.slice('ff_session='.length);

function setup() {
  const invitation = { id: 'invite-a', familyId: family.id, tokenHash: invitationHash(inviteToken), usedAt: null as Date | null, revokedAt: null as Date | null, expiresAt: new Date(Date.now() + 86400_000) };
  const db = {
    family: { findUnique: vi.fn(async () => ({ ...family, members: [{ id: member.id, displayName: member.displayName }] })), findUniqueOrThrow: vi.fn(async () => family) },
    member: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => where.id === admin.id ? admin : where.id === member.id ? member : null),
      findUniqueOrThrow: vi.fn(async () => admin),
      findFirst: vi.fn(async () => member as typeof member | null),
      findMany: vi.fn(async () => [admin, member]),
      create: vi.fn(async ({ data }: { data: typeof member }) => ({ ...data, id: 'new-member', sessionVersion: 0 })),
      updateMany: vi.fn(async ({ where, data }: { where: { id: string; familyId: string }; data: { pinHash: string } }) => {
        if (where.familyId !== member.familyId || where.id !== member.id) return { count: 0 };
        member.pinHash = data.pinHash; member.sessionVersion++; return { count: 1 };
      }),
    },
    familyInvitation: {
      findUnique: vi.fn(async () => invitation),
      findFirst: vi.fn(async () => ({ family })),
      findMany: vi.fn(async () => [invitation]),
      create: vi.fn(async ({ data }: { data: object }) => ({ ...invitation, ...data })),
      updateMany: vi.fn(async () => { if (invitation.usedAt || invitation.revokedAt) return { count: 0 }; invitation.usedAt = new Date(); return { count: 1 }; }),
    },
    device: { findUnique: vi.fn(async () => null as { id: string } | null), create: vi.fn(async () => ({ id: 'device-a' })) },
    devicePairRequest: {
      findUnique: vi.fn(async () => ({ id: 'pair-a', code: '135790', tokenHash: deviceTokenHash('b'.repeat(64), pepper), expiresAt: new Date(Date.now() + 300000), claimedAt: null })),
      updateMany: vi.fn(async () => ({ count: 1 })), deleteMany: vi.fn(), create: vi.fn(),
    },
    $queryRaw: vi.fn(async () => [{ id: family.id }]),
    $transaction: vi.fn(),
  };
  db.$transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) => fn(db));
  const app = createApp({ nodeEnv: 'test', sessionSecret: secret, deviceTokenPepper: pepper, prisma: db as unknown as PrismaClient, s3: null });
  return { db, app, invitation };
}

beforeEach(async () => {
  member.pinHash = await hashPin('123456'); member.sessionVersion = 0;
  admin.pinHash = await hashPin('654321'); admin.sessionVersion = 0;
});

describe('家庭入口、邀请、恢复和设备绑定', () => {
  it('入口只提供家庭及名字，不能直接读照片或获得会话', async () => {
    const { app } = setup();
    const entry = await request(app).get(`/api/auth/family/${family.code}`);
    expect(entry.status).toBe(200);
    expect(entry.body.members).toEqual([{ id: member.id, displayName: member.displayName }]);
    expect(entry.headers['set-cookie']).toBeUndefined();
    expect((await request(app).get('/api/posts')).status).toBe(401);
  });

  it('换手机通过入口、成员 ID 和 PIN 恢复同一身份，不建设备、不新建成员', async () => {
    const { app, db } = setup();
    const res = await request(app).post('/api/auth/login').send({ familyCode: family.code, memberId: member.id, pin: '123456' });
    expect(res.status).toBe(200); expect(res.body.member.id).toBe(member.id);
    expect(res.body.familyCode).toBe(family.code);
    expect(db.member.findFirst).toHaveBeenCalledWith({ where: { familyId: family.id, id: member.id } });
    expect(db.member.create).not.toHaveBeenCalled(); expect(db.device.create).not.toHaveBeenCalled();
    expect(verifySession(cookieToken(res), secret)?.sessionVersion).toBe(0);
  });

  it('管理员重置后旧 PIN、旧会话全部失效，新 PIN 恢复原身份，设备不变', async () => {
    const { app, db } = setup(); const oldCookie = cookie();
    const reset = await request(app).post(`/api/family/members/${member.id}/pin`).set('Cookie', cookie(admin)).send({ pin: '987654', adminPin: '654321' });
    expect(reset.status).toBe(200); expect(await verifyPin('987654', member.pinHash)).toBe(true);
    expect((await request(app).get('/api/auth/me').set('Cookie', oldCookie)).status).toBe(401);
    expect((await request(app).get('/api/family').set('Cookie', oldCookie)).status).toBe(401);
    expect((await request(app).post('/api/auth/login').send({ familyCode: family.code, memberId: member.id, pin: '123456' })).status).toBe(401);
    const restored = await request(app).post('/api/auth/login').send({ familyCode: family.code, memberId: member.id, pin: '987654' });
    expect(restored.status).toBe(200); expect(restored.body.member.id).toBe(member.id);
    expect(verifySession(cookieToken(restored), secret)?.sessionVersion).toBe(1);
    expect(db.device.create).not.toHaveBeenCalled();
  });

  it('普通成员、错误管理员 PIN、跨家庭目标均不能重置 PIN', async () => {
    const { app, db } = setup();
    expect((await request(app).post(`/api/family/members/${member.id}/pin`).set('Cookie', cookie()).send({ pin: '987654', adminPin: '123456' })).status).toBe(403);
    expect((await request(app).post(`/api/family/members/${member.id}/pin`).set('Cookie', cookie(admin)).send({ pin: '987654', adminPin: '000000' })).status).toBe(403);
    expect(db.member.updateMany).not.toHaveBeenCalled();
    expect((await request(app).post('/api/family/members/other-family-member/pin').set('Cookie', cookie(admin)).send({ pin: '987654', adminPin: '654321' })).status).toBe(404);
    expect(member.sessionVersion).toBe(0);
  });

  it('活跃登录续期，过期和伪造家庭身份不能续期', async () => {
    const { app } = setup();
    const res = await request(app).get('/api/auth/me').set('Cookie', cookie(member, 2 * 86400));
    expect(res.status).toBe(200); expect(verifySession(cookieToken(res), secret)!.exp).toBeGreaterThan(Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS - 10);
    const expired = await request(app).get('/api/auth/me').set('Cookie', cookie(member, SESSION_TTL_SECONDS + 1));
    expect(expired.status).toBe(401); expect(expired.headers['set-cookie']).toBeUndefined();
    expect((await request(app).get('/api/auth/me').set('Cookie', cookie({ ...member, familyId: 'other-family' }))).status).toBe(401);
  });

  it('只有管理员能生成邀请，保存的是摘要而非可用邀请令牌', async () => {
    const { app, db } = setup();
    expect((await request(app).post('/api/family/invitations').set('Cookie', cookie()).send({})).status).toBe(403);
    const res = await request(app).post('/api/family/invitations').set('Cookie', cookie(admin)).send({});
    expect(res.status).toBe(201); expect(res.body.token).toMatch(/^[a-f0-9]{64}$/);
    expect(db.familyInvitation.create.mock.calls[0]![0].data).toMatchObject({ tokenHash: invitationHash(res.body.token as string), familyId: family.id });
    expect(JSON.stringify(db.familyInvitation.create.mock.calls)).not.toContain(res.body.token);
  });

  it('首次加入创建普通成员并登录，重复兑换不创建第二个人', async () => {
    const { app, db } = setup(); db.member.findFirst.mockResolvedValue(null);
    const res = await request(app).post('/api/auth/join').send({ token: inviteToken, displayName: '新家人', pin: '123456', role: 'ADMIN' });
    expect(res.status).toBe(201); expect(res.body.member.role).toBe('MEMBER');
    expect(db.$queryRaw).toHaveBeenCalled();
    expect((await request(app).post('/api/auth/join').send({ token: inviteToken, displayName: '另一个人', pin: '123456' })).status).toBe(400);
    expect(db.member.create).toHaveBeenCalledTimes(1);
  });

  it('过期、撤销、同名及竞争中失效的邀请都不创建成员', async () => {
    const { app, db, invitation } = setup();
    const join = () => request(app).post('/api/auth/join').send({ token: inviteToken, displayName: member.displayName, pin: '123456' });
    invitation.expiresAt = new Date(0); expect((await join()).status).toBe(400);
    invitation.expiresAt = new Date(Date.now() + 86400_000); invitation.revokedAt = new Date(); expect((await join()).status).toBe(400);
    invitation.revokedAt = null; expect((await join()).status).toBe(400);
    db.member.findFirst.mockResolvedValue(null); db.familyInvitation.updateMany.mockResolvedValue({ count: 0 });
    expect((await join()).status).toBe(400); expect(db.member.create).not.toHaveBeenCalled();
  });

  it('管理员手机输入设备码只绑定设备，不返回设备凭证；短码不能查询绑定凭证', async () => {
    const { app, db } = setup();
    expect((await request(app).post('/api/pair/claim').set('Cookie', cookie()).send({ code: '135790' })).status).toBe(403);
    const res = await request(app).post('/api/pair/claim').set('Cookie', cookie(admin)).send({ code: '135790' });
    expect(res.status).toBe(200); expect(res.body).toEqual({ ok: true });
    expect(db.device.create).toHaveBeenCalledWith({ data: { familyId: family.id, name: '家庭相框', tokenHash: deviceTokenHash('b'.repeat(64), pepper) } });
    expect((await request(app).post('/api/pair/status').send({ code: '135790' })).status).toBe(400);
    db.devicePairRequest.updateMany.mockResolvedValue({ count: 0 });
    expect((await request(app).post('/api/pair/claim').set('Cookie', cookie(admin)).send({ code: '135790' })).status).toBe(400);
    expect(db.device.create).toHaveBeenCalledTimes(1);
  });

  it('相框断网重开后用原凭证恢复已绑定状态，不重复建设备', async () => {
    const { app, db } = setup(); db.device.findUnique.mockResolvedValue({ id: 'device-a' });
    expect((await request(app).post('/api/pair/start').send({ deviceToken: 'b'.repeat(64) })).body).toEqual({ paired: true });
    expect((await request(app).post('/api/pair/status').send({ deviceToken: 'b'.repeat(64) })).body).toEqual({ paired: true, expired: false });
    expect(db.device.create).not.toHaveBeenCalled(); expect(db.devicePairRequest.create).not.toHaveBeenCalled();
  });
});

