import { describe, expect, it } from 'vitest';
import { EnvValidationError, parseEnv } from '../src/config/env';

const base = {
  DATABASE_URL: 'mysql://root:pw@127.0.0.1:3306/family_frame',
};

describe('parseEnv', () => {
  it('parses minimal dev config with defaults', () => {
    const cfg = parseEnv(base);
    expect(cfg.nodeEnv).toBe('development');
    expect(cfg.port).toBe(3000);
    expect(cfg.databaseUrl).toBe(base.DATABASE_URL);
    expect(cfg.s3).toBeNull();
    expect(cfg.sessionSecret).toBeNull();
    expect(cfg.deviceTokenPepper).toBeNull();
    expect(cfg.publicAppUrl).toBeNull();
  });

  it('rejects missing DATABASE_URL', () => {
    expect(() => parseEnv({})).toThrow(EnvValidationError);
    try {
      parseEnv({});
    } catch (err) {
      expect(err).toBeInstanceOf(EnvValidationError);
      expect((err as EnvValidationError).issues.join('\n')).toContain('DATABASE_URL');
    }
  });

  it('rejects non-mysql DATABASE_URL', () => {
    expect(() =>
      parseEnv({ DATABASE_URL: 'postgresql://root:pw@127.0.0.1:5432/x' }),
    ).toThrow(/mysql:\/\//);
  });

  it('coerces PORT and honours overrides', () => {
    expect(parseEnv({ ...base, PORT: '8080' }).port).toBe(8080);
  });

  it('rejects PORT out of range', () => {
    expect(() => parseEnv({ ...base, PORT: '99999' })).toThrow(EnvValidationError);
    expect(() => parseEnv({ ...base, PORT: 'not-a-number' })).toThrow(EnvValidationError);
  });

  it('treats empty strings as unset', () => {
    const cfg = parseEnv({ ...base, SESSION_SECRET: '' });
    expect(cfg.sessionSecret).toBeNull();
  });

  it('rejects partial S3 config', () => {
    expect(() => parseEnv({ ...base, S3_ENDPOINT: 'https://s3.example.com' })).toThrow(
      /同时配置/,
    );
    expect(() => parseEnv({ ...base, S3_REGION: 'us-east-1' })).toThrow(/成套/);
  });

  it('accepts complete S3 config', () => {
    const cfg = parseEnv({
      ...base,
      S3_ENDPOINT: 'https://s3.example.com',
      S3_REGION: 'us-east-1',
      S3_BUCKET: 'family-frame',
      S3_ACCESS_KEY: 'ak',
      S3_SECRET_KEY: 'sk',
    });
    expect(cfg.s3).not.toBeNull();
    expect(cfg.s3?.bucket).toBe('family-frame');
  });

  it('rejects invalid PUBLIC_APP_URL', () => {
    expect(() => parseEnv({ ...base, PUBLIC_APP_URL: 'not a url' })).toThrow(
      /URL/,
    );
  });

  describe('production hard-fails', () => {
    const prod = { ...base, NODE_ENV: 'production' };

    it('requires SESSION_SECRET / DEVICE_TOKEN_PEPPER / S3_* / 双 endpoint', () => {
      try {
        parseEnv(prod);
        expect.unreachable('parseEnv should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(EnvValidationError);
        const all = (err as EnvValidationError).issues.join('\n');
        expect(all).toContain('SESSION_SECRET');
        expect(all).toContain('DEVICE_TOKEN_PEPPER');
        expect(all).toContain('S3_');
      }
    });

    it('requires S3_INTERNAL_ENDPOINT / S3_PUBLIC_ENDPOINT（浏览器 presigned URL 不能用内网地址）', () => {
      const full = {
        ...prod,
        SESSION_SECRET: 's'.repeat(32),
        DEVICE_TOKEN_PEPPER: 'p'.repeat(32),
        S3_ENDPOINT: 'https://s3.example.com',
        S3_REGION: 'us-east-1',
        S3_BUCKET: 'b',
        S3_ACCESS_KEY: 'ak',
        S3_SECRET_KEY: 'sk',
      };
      expect(() => parseEnv(full)).toThrow(/INTERNAL_ENDPOINT/);

      const withBoth = {
        ...full,
        S3_INTERNAL_ENDPOINT: 'http://minio.sealos.internal:9000',
        S3_PUBLIC_ENDPOINT: 'https://obj.example.com',
      };
      const cfg = parseEnv(withBoth);
      expect(cfg.s3?.internalEndpoint).toContain('internal');
      expect(cfg.s3?.publicEndpoint).toContain('obj.example.com');
    });

    it('rejects short SESSION_SECRET', () => {
      expect(() =>
        parseEnv({
          ...prod,
          SESSION_SECRET: 'short',
          DEVICE_TOKEN_PEPPER: 'x'.repeat(32),
          S3_ENDPOINT: 'https://s3.example.com',
          S3_REGION: 'us-east-1',
          S3_BUCKET: 'b',
          S3_ACCESS_KEY: 'ak',
          S3_SECRET_KEY: 'sk',
          S3_INTERNAL_ENDPOINT: 'http://internal',
          S3_PUBLIC_ENDPOINT: 'https://public',
        }),
      ).toThrow(/SESSION_SECRET/);
    });

    it('passes with complete production config', () => {
      const cfg = parseEnv({
        ...prod,
        SESSION_SECRET: 's'.repeat(32),
        DEVICE_TOKEN_PEPPER: 'p'.repeat(32),
        S3_ENDPOINT: 'https://s3.example.com',
        S3_REGION: 'us-east-1',
        S3_BUCKET: 'b',
        S3_ACCESS_KEY: 'ak',
        S3_SECRET_KEY: 'sk',
        S3_INTERNAL_ENDPOINT: 'http://minio.internal:9000',
        S3_PUBLIC_ENDPOINT: 'https://obj.example.com',
        WEB_DIST_DIR: '/app/apps/web/dist',
      });
      expect(cfg.sessionSecret).not.toBeNull();
      expect(cfg.s3).not.toBeNull();
      expect(cfg.webDistDir).toBe('/app/apps/web/dist');
    });
  });
});
