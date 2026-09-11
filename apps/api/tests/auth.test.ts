import { describe, expect, it } from 'vitest';
import { hashPin, verifyPin } from '../src/auth/pin';
import {
  buildClearSessionCookie,
  buildSessionCookie,
  SESSION_COOKIE_NAME,
  SESSION_TTL_SECONDS,
  signSession,
  verifySession,
} from '../src/auth/session';
import { deviceTokenHash, generateDeviceToken } from '../src/auth/deviceToken';
import { sniffMime } from '../src/lib/sniff';

const SECRET = 'test-session-secret-0123456789abcdef';

describe('PIN 哈希（PRD §16：不存原始密码）', () => {
  it('roundtrip：正确 PIN 通过，错误 PIN 拒绝', async () => {
    const stored = await hashPin('123456');
    expect(stored.startsWith('scrypt$')).toBe(true);
    expect(stored).not.toContain('123456');
    expect(await verifyPin('123456', stored)).toBe(true);
    expect(await verifyPin('654321', stored)).toBe(false);
  }, 20000);

  it('拒绝被篡改的存储串与异常格式', async () => {
    const stored = await hashPin('123456');
    expect(await verifyPin('123456', stored + 'x')).toBe(false);
    expect(await verifyPin('123456', 'garbage')).toBe(false);
    expect(await verifyPin('123456', 'plain$1$2$3$4$5')).toBe(false);
  }, 20000);
});

describe('签名会话', () => {
  const payload = { memberId: 'm1', familyId: 'f1', role: 'MEMBER' as const };

  it('签发后可验证，payload 完整', () => {
    const token = signSession(payload, SECRET);
    const verified = verifySession(token, SECRET);
    expect(verified).not.toBeNull();
    expect(verified?.memberId).toBe('m1');
    expect(verified?.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it('篡改签名后验证失败', () => {
    const token = signSession(payload, SECRET);
    const [body] = token.split('.');
    expect(verifySession(`${body}.badSignature`, SECRET)).toBeNull();
    expect(verifySession(`${body}x.${token.split('.')[1]}`, SECRET)).toBeNull();
  });

  it('错误 secret 签发的会话验证失败', () => {
    const token = signSession(payload, 'another-secret-0123456789abcdef01234567');
    expect(verifySession(token, SECRET)).toBeNull();
  });

  it('过期会话验证失败', () => {
    const token = signSession(payload, SECRET, Math.floor(Date.now() / 1000) - SESSION_TTL_SECONDS - 1);
    expect(verifySession(token, SECRET)).toBeNull();
  });

  it('Cookie 属性：HttpOnly/SameSite，生产带 Secure；清除 Cookie Max-Age=0', () => {
    const devCookie = buildSessionCookie('abc', false);
    expect(devCookie).toContain('HttpOnly');
    expect(devCookie).toContain('SameSite=Lax');
    expect(devCookie).not.toContain('Secure');
    const prodCookie = buildSessionCookie('abc', true);
    expect(prodCookie).toContain('Secure');
    expect(buildClearSessionCookie(true)).toContain('Max-Age=0');
    expect(SESSION_COOKIE_NAME).toBe('ff_session');
  });
});

describe('设备 token（PRD §16：只存 hash）', () => {
  it('token 随机且 hash 稳定可复现', () => {
    const t1 = generateDeviceToken();
    const t2 = generateDeviceToken();
    expect(t1).not.toBe(t2);
    expect(deviceTokenHash(t1, 'pepper')).toBe(deviceTokenHash(t1, 'pepper'));
    expect(deviceTokenHash(t1, 'pepper')).not.toBe(deviceTokenHash(t1, 'other-pepper'));
    expect(deviceTokenHash(t1, 'pepper')).not.toContain(t1);
  });
});

describe('上传内容魔数嗅探（PRD §16：防止任意文件上传）', () => {
  it('识别 JPEG / PNG / WebP', () => {
    expect(sniffMime(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]))).toBe('image/jpeg');
    expect(
      sniffMime(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])),
    ).toBe('image/png');
    const webp = Buffer.concat([Buffer.from('RIFF0000WEBPVP8 '), Buffer.alloc(4)]);
    expect(sniffMime(webp)).toBe('image/webp');
  });

  it('识别 WebM / Ogg / MP4 / MP3', () => {
    expect(sniffMime(Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x00, 0x00]))).toBe('audio/webm');
    expect(sniffMime(Buffer.from('OggS0000'))).toBe('audio/ogg');
    expect(sniffMime(Buffer.from('0000ftypM4A '))).toBe('audio/mp4');
    expect(sniffMime(Buffer.from('ID3\x03\x00\x00'))).toBe('audio/mpeg');
  });

  it('文本与随机字节返回 null（拒绝任意文件上传）', () => {
    expect(sniffMime(Buffer.from('<html>hello</html>'))).toBeNull();
    expect(sniffMime(Buffer.from('{"a":1}'))).toBeNull();
    expect(sniffMime(Buffer.alloc(0))).toBeNull();
  });
});
