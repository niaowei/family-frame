import { describe, expect, it, vi } from 'vitest';
import { createRateLimit } from '../src/middleware/rateLimit';

describe('简单限流（PRD §16）', () => {
  it('窗口内超过 max 返回 429，窗口重置后恢复', () => {
    let now = 1_000_000;
    const limiter = createRateLimit({ windowMs: 1000, max: 2, now: () => now });

    const req = { ip: '1.2.3.4' } as never;
    const next = vi.fn();
    const res = {
      status: (code: number) => ({
        json: (body: unknown) => {
          expect(code).toBe(429);
          expect((body as { error: string }).error).toBe('rate_limited');
        },
      }),
      getHeader: () => undefined,
    } as never;

    limiter(req, res, next);
    limiter(req, res, next);
    expect(next).toHaveBeenCalledTimes(2);

    // 第 3 次 → 429
    limiter(req, res, next);
    expect(next).toHaveBeenCalledTimes(2);

    // 窗口过期 → 放行
    now += 1001;
    limiter(req, res, next);
    expect(next).toHaveBeenCalledTimes(3);
  });

  it('不同 key 互不影响', () => {
    const limiter = createRateLimit({ windowMs: 1000, max: 1, now: () => 0 });
    const next = vi.fn();
    const res = { status: () => ({ json: () => undefined }), getHeader: () => undefined } as never;
    limiter({ ip: 'a' } as never, res, next);
    limiter({ ip: 'b' } as never, res, next);
    expect(next).toHaveBeenCalledTimes(2);
  });
});
