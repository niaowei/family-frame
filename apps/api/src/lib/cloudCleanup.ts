import type { PrismaClient } from '@prisma/client';
import type { S3Service } from './s3';

export interface CloudCleanupResult {
  cutoff: string;
  cleanedPostIds: string[];
  skippedPostIds: string[];
  failedPostIds: string[];
}

export function nextBeijingCutoff(now = new Date()): Date {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now);
  const value = (type: string): number => Number(parts.find((p) => p.type === type)?.value);
  const cutoff = Date.UTC(value('year'), value('month') - 1, value('day'), 15, 59, 0, 0);
  return new Date(now.getTime() >= cutoff ? cutoff + 86_400_000 : cutoff);
}

export function scheduleCloudCleanup(input: { prisma: PrismaClient; s3: S3Service }): () => void {
  let stopped = false;
  let running = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const schedule = (): void => {
    if (stopped) return;
    const cutoff = nextBeijingCutoff();
    const delay = Math.max(1_000, cutoff.getTime() - Date.now());
    timer = setTimeout(() => {
      timer = null;
      if (!running) {
        running = true;
        void runCloudCleanup({ ...input, cutoff, dryRun: false }).catch(() => undefined).finally(() => {
          running = false;
          schedule();
        });
      } else schedule();
    }, delay);
    timer.unref?.();
  };
  schedule();
  return () => { stopped = true; if (timer) clearTimeout(timer); };
}

/** 删除云端中转副本，不删除相框本地内容。 */
export async function runCloudCleanup(input: {
  prisma: PrismaClient;
  s3: S3Service;
  cutoff: Date;
  dryRun?: boolean;
}): Promise<CloudCleanupResult> {
  const { prisma, s3, cutoff, dryRun = true } = input;
  const result: CloudCleanupResult = {
    cutoff: cutoff.toISOString(), cleanedPostIds: [], skippedPostIds: [], failedPostIds: [],
  };
  const posts = await prisma.post.findMany({
    where: { createdAt: { lt: cutoff }, deletedAt: null, cloudCleanedAt: null },
    include: { media: true, deliveries: true, family: { include: { devices: true } } },
    orderBy: { createdAt: 'asc' },
  });
  for (const post of posts) {
    const targetDevices = post.family.devices.filter((d) => d.createdAt <= post.createdAt);
    const completeDeviceIds = new Set(post.deliveries.filter((d) => d.completeAt !== null).map((d) => d.deviceId));
    if (targetDevices.length === 0 || targetDevices.some((d) => !completeDeviceIds.has(d.id))) {
      result.skippedPostIds.push(post.id);
      continue;
    }
    if (dryRun) { result.cleanedPostIds.push(post.id); continue; }
    try {
      for (const media of post.media) await s3.deleteObject(media.objectKey);
      await prisma.$transaction([
        prisma.media.deleteMany({ where: { postId: post.id } }),
        prisma.post.update({ where: { id: post.id }, data: { cloudCleanedAt: cutoff } }),
      ]);
      result.cleanedPostIds.push(post.id);
    } catch { result.failedPostIds.push(post.id); }
  }
  return result;
}
