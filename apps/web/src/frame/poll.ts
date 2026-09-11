/**
 * 相框轮询节奏（PRD §15）：
 * - 每 30 分钟抓取一次；
 * - 请求失败指数退避，最大 1 小时；
 * - 成功后恢复 30 分钟。
 * 纯函数，便于单元测试。同一时间只允许一个在途请求由 useFrameFeed 保证。
 */

export const POLL_INTERVAL_MS = 30 * 60_000;
export const MAX_BACKOFF_MS = 60 * 60_000;

export function nextPollDelayMs(
  prevDelayMs: number,
  succeeded: boolean,
  baseMs: number = POLL_INTERVAL_MS,
  maxMs: number = MAX_BACKOFF_MS,
): number {
  if (succeeded) return baseMs;
  const doubled = Math.max(baseMs, prevDelayMs) * 2;
  return Math.min(doubled, maxMs);
}
