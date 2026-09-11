/**
 * 浏览器端图片压缩（PRD §11）：
 * 1. 读取并修正 EXIF 方向（<img> 解码在现代浏览器遵循 image-orientation: from-image）；
 * 2. 最大长边 1920；
 * 3. 优先转 WebP（质量 0.83），浏览器不支持 WebP 编码时回退 JPEG（0.85）；
 * 4. canvas 重编码天然去除 EXIF/GPS 元数据；
 * 5. 返回压缩后的宽高（写入 Media 元数据）。
 */

export const MAX_EDGE = 1920;
export const WEBP_QUALITY = 0.83;
export const JPEG_QUALITY = 0.85;

export interface CompressedImage {
  blob: Blob;
  width: number;
  height: number;
  mimeType: string;
}

export class ImageDecodeError extends Error {
  constructor(message = '无法读取这张图片，请换一张（暂不支持 HEIC 格式）') {
    super(message);
    this.name = 'ImageDecodeError';
  }
}

async function decodeImage(file: Blob): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return img;
  } catch {
    throw new ImageDecodeError();
  } finally {
    // decode 完成或失败后释放；img 已持有解码数据
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

function canvasToBlob(canvas: HTMLCanvasElement, mimeType: string, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => {
    canvas.toBlob((blob) => resolve(blob), mimeType, quality);
  });
}

export async function compressImage(file: File | Blob): Promise<CompressedImage> {
  const img = await decodeImage(file);
  const scale = Math.min(1, MAX_EDGE / Math.max(img.naturalWidth, img.naturalHeight));
  const width = Math.max(1, Math.round(img.naturalWidth * scale));
  const height = Math.max(1, Math.round(img.naturalHeight * scale));

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('浏览器不支持图片压缩');
  ctx.drawImage(img, 0, 0, width, height);

  // 优先 WebP；不支持编码时（blob 为 null 或类型不符）回退 JPEG（PRD §11 第 4-5 条）
  const webp = await canvasToBlob(canvas, 'image/webp', WEBP_QUALITY);
  if (webp && webp.type === 'image/webp') {
    return { blob: webp, width, height, mimeType: 'image/webp' };
  }
  const jpeg = await canvasToBlob(canvas, 'image/jpeg', JPEG_QUALITY);
  if (jpeg && jpeg.type === 'image/jpeg') {
    return { blob: jpeg, width, height, mimeType: 'image/jpeg' };
  }
  throw new Error('浏览器不支持图片压缩');
}
