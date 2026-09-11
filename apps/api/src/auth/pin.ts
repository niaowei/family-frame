import crypto from 'node:crypto';
import type { ScryptOptions } from 'node:crypto';

/**
 * 成员 PIN 哈希（PRD §16：数据库不存原始密码）。
 * 使用 Node 内置 scrypt，无额外原生依赖。
 * 存储格式：scrypt$N$r$p$salt(base64)$hash(base64)
 */

const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1 } as const;
const KEY_LENGTH = 64;

function scryptAsync(
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: ScryptOptions,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, keylen, options, (err, derived) => {
      if (err) reject(err);
      else resolve(derived);
    });
  });
}

export async function hashPin(pin: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const hash = await scryptAsync(pin, salt, KEY_LENGTH, SCRYPT_PARAMS);
  return [
    'scrypt',
    SCRYPT_PARAMS.N,
    SCRYPT_PARAMS.r,
    SCRYPT_PARAMS.p,
    salt.toString('base64'),
    hash.toString('base64'),
  ].join('$');
}

export async function verifyPin(pin: string, stored: string): Promise<boolean> {
  try {
    const parts = stored.split('$');
    if (parts.length !== 6) return false;
    const [scheme, nStr, rStr, pStr, saltB64, hashB64] = parts;
    if (scheme !== 'scrypt') return false;
    const N = Number.parseInt(nStr ?? '', 10);
    const r = Number.parseInt(rStr ?? '', 10);
    const p = Number.parseInt(pStr ?? '', 10);
    if (!Number.isFinite(N) || !Number.isFinite(r) || !Number.isFinite(p)) return false;
    const salt = Buffer.from(saltB64 ?? '', 'base64');
    const expected = Buffer.from(hashB64 ?? '', 'base64');
    // 规范形式校验：Node 的 base64 解码会忽略非法尾部字符，
    // 必须确认存储串本身是规范 base64，否则 "hash+x" 这类篡改会被静默接受。
    if (expected.length === 0 || expected.toString('base64') !== hashB64) return false;
    const actual = await scryptAsync(pin, salt, expected.length, { N, r, p });
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}
