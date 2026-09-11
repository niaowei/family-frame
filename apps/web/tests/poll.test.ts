import { describe, expect, it } from 'vitest';
import { MAX_BACKOFF_MS, nextPollDelayMs, POLL_INTERVAL_MS } from '../src/frame/poll';

/**
 * 相框轮询节奏（PRD §15）：
 * 成功恢复 30 分钟；失败指数退避；最大 1 小时。
 */
describe('nextPollDelayMs', () => {
  it('常量符合确认节奏：30 分钟抓取、1 小时最大退避', () => {
    expect(POLL_INTERVAL_MS).toBe(30 * 60_000);
    expect(MAX_BACKOFF_MS).toBe(60 * 60_000);
  });

  it('成功后恢复 30 分钟（无论之前退避到多少）', () => {
    expect(nextPollDelayMs(POLL_INTERVAL_MS, true)).toBe(30 * 60_000);
    expect(nextPollDelayMs(60_000, true)).toBe(30 * 60_000);
    expect(nextPollDelayMs(30_000, true)).toBe(30 * 60_000);
  });

  it('失败指数退避：30 分钟 → 1 小时', () => {
    expect(nextPollDelayMs(POLL_INTERVAL_MS, false)).toBe(60 * 60_000);
    expect(nextPollDelayMs(30_000, false)).toBe(60 * 60_000);
  });

  it('退避封顶 1 小时，不再增长', () => {
    expect(nextPollDelayMs(60 * 60_000, false)).toBe(60 * 60_000);
    expect(nextPollDelayMs(120 * 60_000, false)).toBe(60 * 60_000);
  });

  it('连续失败序列封顶 1 小时，成功后回到 30 分钟', () => {
    let delay = POLL_INTERVAL_MS;
    const seq: number[] = [];
    for (let i = 0; i < 4; i++) {
      delay = nextPollDelayMs(delay, false);
      seq.push(delay);
    }
    expect(seq).toEqual([60 * 60_000, 60 * 60_000, 60 * 60_000, 60 * 60_000]);
    expect(nextPollDelayMs(delay, true)).toBe(30 * 60_000);
  });

  it('base/max 可注入（便于测试与未来配置）', () => {
    expect(nextPollDelayMs(100, false, 100, 400)).toBe(200);
    expect(nextPollDelayMs(200, false, 100, 400)).toBe(400);
    expect(nextPollDelayMs(400, false, 100, 400)).toBe(400);
    expect(nextPollDelayMs(400, true, 100, 400)).toBe(100);
  });
});
