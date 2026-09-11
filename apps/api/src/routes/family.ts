import crypto from 'node:crypto';
import { Router } from 'express';
import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { ApiErrorCode } from '@family-frame/shared';
import { hashPin, verifyPin } from '../auth/pin';
import { invitationHash, newPinSchema } from './auth';

export function familyRouter(prisma: PrismaClient): Router {
  const router = Router();
  router.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  router.get('/', async (req, res, next) => {
    try {
      const family = await prisma.family.findUniqueOrThrow({ where: { id: req.member!.familyId }, select: { name: true, code: true } });
      const members = req.member!.role === 'ADMIN' ? await prisma.member.findMany({ where: { familyId: req.member!.familyId }, select: { id: true, displayName: true, role: true }, orderBy: { createdAt: 'asc' } }) : [];
      const invitations = req.member!.role === 'ADMIN' ? await prisma.familyInvitation.findMany({ where: { familyId: req.member!.familyId, usedAt: null, revokedAt: null, expiresAt: { gt: new Date() } }, select: { id: true, expiresAt: true, createdAt: true }, orderBy: { createdAt: 'desc' } }) : [];
      res.json({ ...family, members, invitations });
    } catch (err) { next(err); }
  });
  router.use((req, res, next) => {
    if (req.member!.role !== 'ADMIN') { res.status(403).json({ error: ApiErrorCode.Forbidden, message: '请家庭管理员操作' }); return; }
    next();
  });
  router.post('/invitations', async (req, res, next) => {
    try {
      const token = crypto.randomBytes(32).toString('hex');
      const invitation = await prisma.familyInvitation.create({ data: { familyId: req.member!.familyId, tokenHash: invitationHash(token), expiresAt: new Date(Date.now() + 24 * 3600_000) } });
      res.status(201).json({ id: invitation.id, token, expiresAt: invitation.expiresAt });
    } catch (err) { next(err); }
  });
  router.delete('/invitations/:id', async (req, res, next) => {
    try {
      const id = z.string().min(1).max(64).parse(req.params.id);
      await prisma.familyInvitation.updateMany({ where: { id, familyId: req.member!.familyId, usedAt: null, revokedAt: null }, data: { revokedAt: new Date() } });
      res.json({ ok: true });
    } catch (err) { next(err); }
  });
  router.post('/members/:id/pin', async (req, res, next) => {
    try {
      const id = z.string().min(1).max(64).safeParse(req.params.id);
      const parsed = z.object({ pin: newPinSchema, adminPin: z.string().min(4).max(20) }).safeParse(req.body);
      if (!id.success || !parsed.success) { res.status(400).json({ error: ApiErrorCode.BadRequest, message: '请填写管理员当前 PIN 和新的 6 至 20 位数字 PIN' }); return; }
      const admin = await prisma.member.findUniqueOrThrow({ where: { id: req.member!.id } });
      if (!await verifyPin(parsed.data.adminPin, admin.pinHash)) { res.status(403).json({ error: ApiErrorCode.Forbidden, message: '管理员 PIN 不正确' }); return; }
      const result = await prisma.member.updateMany({ where: { id: id.data, familyId: req.member!.familyId }, data: { pinHash: await hashPin(parsed.data.pin), sessionVersion: { increment: 1 } } });
      if (result.count !== 1) { res.status(404).json({ error: ApiErrorCode.NotFound, message: '找不到这个家庭成员' }); return; }
      res.json({ ok: true });
    } catch (err) { next(err); }
  });
  return router;
}
