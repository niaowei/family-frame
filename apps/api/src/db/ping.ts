import { prisma } from './prisma';

export interface DbPingResult {
  ok: boolean;
  latencyMs: number | null;
  error?: string;
}

/** 真实执行 SELECT 1，返回延迟或失败原因（供 /health/db 使用）。
 *  错误仅返回稳定名称/代码，不含连接串、主机等敏感细节（PRD M5 §九）。 */
export async function pingDatabase(timeoutMs = 3000): Promise<DbPingResult> {
  const startedAt = performance.now();
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      prisma.$queryRaw`SELECT 1`,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(Object.assign(new Error('database ping timeout'), { name: 'PingTimeoutError' })),
          timeoutMs,
        );
        timer.unref();
      }),
    ]);
    return { ok: true, latencyMs: Math.round(performance.now() - startedAt) };
  } catch (err) {
    const name =
      err instanceof Error
        ? (err.name || 'DatabaseError')
        : 'DatabaseError';
    return { ok: false, latencyMs: null, error: name };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
