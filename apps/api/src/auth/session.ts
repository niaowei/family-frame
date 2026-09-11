import crypto from 'node:crypto';

/**
 * 无状态签名会话（PRD §14：登录返回 session/cookie）。
 * Cookie 值 = base64url(payload).base64url(HMAC-SHA256(payload, SESSION_SECRET))
 * 服务端不存会话表；签名防篡改，exp 防过期。
 */

export const SESSION_COOKIE_NAME = 'ff_session';
export const SESSION_TTL_SECONDS = 180 * 24 * 60 * 60; // 半年未使用才需重新登录；活跃时续期

export interface SessionPayload {
  memberId: string;
  familyId: string;
  role: 'ADMIN' | 'MEMBER';
  sessionVersion?: number;
  /** 过期时间（秒级 Unix 时间戳） */
  exp: number;
}

function hmac(value: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(value).digest('base64url');
}

export function signSession(
  payload: Omit<SessionPayload, 'exp'>,
  secret: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): string {
  const full: SessionPayload = { ...payload, exp: nowSeconds + SESSION_TTL_SECONDS };
  const body = Buffer.from(JSON.stringify(full)).toString('base64url');
  return `${body}.${hmac(body, secret)}`;
}

export function verifySession(
  value: string | undefined,
  secret: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): SessionPayload | null {
  if (!value) return null;
  const dot = value.lastIndexOf('.');
  if (dot <= 0) return null;
  const body = value.slice(0, dot);
  const sig = value.slice(dot + 1);
  const expected = hmac(body, secret);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as SessionPayload;
    if (
      typeof payload.memberId !== 'string' ||
      typeof payload.familyId !== 'string' ||
      (payload.role !== 'ADMIN' && payload.role !== 'MEMBER') ||
      typeof payload.exp !== 'number'
      || !Number.isFinite(payload.exp)
      || (payload.sessionVersion !== undefined && (!Number.isSafeInteger(payload.sessionVersion) || payload.sessionVersion < 0))
    ) {
      return null;
    }
    if (payload.exp <= nowSeconds) return null;
    return payload;
  } catch {
    return null;
  }
}

export function buildSessionCookie(value: string, isProduction: boolean): string {
  const parts = [
    `${SESSION_COOKIE_NAME}=${value}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${SESSION_TTL_SECONDS}`,
  ];
  if (isProduction) parts.push('Secure');
  return parts.join('; ');
}

export function buildClearSessionCookie(isProduction: boolean): string {
  const parts = [`${SESSION_COOKIE_NAME}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (isProduction) parts.push('Secure');
  return parts.join('; ');
}
