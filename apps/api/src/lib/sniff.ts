/**
 * 上传内容魔数嗅探（PRD §16：防止任意文件上传）。
 * presign 阶段校验声明的 mimeType 白名单与大小；
 * 落库（POST /api/posts）阶段再嗅探对象真实字节，双重校验。
 */

export type UploadType = 'photo' | 'voice' | 'video';
export const VIDEO_MAX_BYTES = 50 * 1024 * 1024;

export const PHOTO_MIME_WHITELIST = ['image/jpeg', 'image/png', 'image/webp'] as const;
export const VOICE_MIME_WHITELIST = [
  'audio/webm',
  'audio/mp4',
  'audio/ogg',
  'audio/mpeg',
  'audio/wav',
] as const;

export const PHOTO_MAX_BYTES = 8 * 1024 * 1024; // 浏览器压缩后通常 < 500KB，留足余量
export const VOICE_MAX_BYTES = 5 * 1024 * 1024; // 30 秒 opus 音频通常 < 500KB

export function isAllowedMime(type: UploadType, mime: string): boolean {
  const whitelist = type === 'video' ? ['video/mp4'] : type === 'photo' ? PHOTO_MIME_WHITELIST : VOICE_MIME_WHITELIST;
  return (whitelist as readonly string[]).includes(mime);
}

export function maxBytesFor(type: UploadType): number {
  return type === 'video' ? VIDEO_MAX_BYTES : type === 'photo' ? PHOTO_MAX_BYTES : VOICE_MAX_BYTES;
}

const MIME_TO_EXT: Record<string, string> = {
  'video/mp4': 'mp4',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'audio/webm': 'webm',
  'audio/mp4': 'm4a',
  'audio/ogg': 'ogg',
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
};

export function extForMime(mime: string): string {
  return MIME_TO_EXT[mime] ?? 'bin';
}

/**
 * 从文件头字节判断真实 MIME 类型。
 * 返回 null 表示无法识别（拒绝）。
 */
export function sniffMime(head: Buffer, type?: UploadType): string | null {
  if (head.length < 4) return null;
  // JPEG: FF D8 FF
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'image/jpeg';
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    head.length >= 8 &&
    head[0] === 0x89 &&
    head[1] === 0x50 &&
    head[2] === 0x4e &&
    head[3] === 0x47 &&
    head[4] === 0x0d &&
    head[5] === 0x0a &&
    head[6] === 0x1a &&
    head[7] === 0x0a
  ) {
    return 'image/png';
  }
  // WebP: RIFF....WEBP
  if (
    head.length >= 12 &&
    head.subarray(0, 4).toString('latin1') === 'RIFF' &&
    head.subarray(8, 12).toString('latin1') === 'WEBP'
  ) {
    return 'image/webp';
  }
  // WAV: RIFF....WAVE
  if (
    head.length >= 12 &&
    head.subarray(0, 4).toString('latin1') === 'RIFF' &&
    head.subarray(8, 12).toString('latin1') === 'WAVE'
  ) {
    return 'audio/wav';
  }
  // Matroska/WebM/EBML: 1A 45 DF A3
  if (head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) {
    return 'audio/webm';
  }
  // OggS
  if (head.subarray(0, 4).toString('latin1') === 'OggS') return 'audio/ogg';
  // MP4/ mov: offset 4..8 == 'ftyp'
  // Container check only: codec compatibility is checked by the player, not by this header.
  if (head.length >= 12 && head.subarray(4, 8).toString('latin1') === 'ftyp') {
    return type === 'video' ? 'video/mp4' : 'audio/mp4';
  }
  // MP3: ID3 或帧同步
  if (head.subarray(0, 3).toString('latin1') === 'ID3') return 'audio/mpeg';
  if (head[0] === 0xff && (head[1] ?? 0) & 0xe0) return 'audio/mpeg';
  return null;
}
