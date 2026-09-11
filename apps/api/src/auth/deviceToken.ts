import crypto from 'node:crypto';

/**
 * 相框设备 token（PRD §16：随机 device token，服务端只存 hash）。
 * tokenHash = SHA-256(DEVICE_TOKEN_PEPPER + ':' + token)
 * M2 由 seed 生成首台设备；配对 API 在相框端里程碑（M3+）实现。
 */

export function generateDeviceToken(): string {
  return crypto.randomBytes(24).toString('hex');
}

export function deviceTokenHash(token: string, pepper: string): string {
  return crypto.createHash('sha256').update(`${pepper}:${token}`).digest('hex');
}
