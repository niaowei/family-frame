import { describe, expect, it } from 'vitest';
import { ApiErrorCode, APP_NAME } from '../src/index';

describe('shared', () => {
  it('exports a non-empty app name', () => {
    expect(APP_NAME.length).toBeGreaterThan(0);
  });

  it('exports error codes as a frozen-shape constant', () => {
    expect(Object.values(ApiErrorCode)).toContain('not_found');
    expect(Object.values(ApiErrorCode)).toContain('internal_error');
  });
});
