import { describe, expect, it } from 'vitest';
import { nextBeijingCutoff } from '../src/lib/cloudCleanup';

describe('cloud cleanup cutoff', () => {
  it('uses the next 23:59 Asia/Shanghai boundary', () => {
    expect(nextBeijingCutoff(new Date('2026-09-11T15:58:59.000Z')).toISOString()).toBe('2026-09-11T15:59:00.000Z');
    expect(nextBeijingCutoff(new Date('2026-09-11T15:59:00.000Z')).toISOString()).toBe('2026-09-12T15:59:00.000Z');
  });
});
