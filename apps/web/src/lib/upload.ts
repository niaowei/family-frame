import { api } from './api';
import type { PresignResponse } from '@family-frame/shared';

/**
 * 上传链路（PRD §14）：presign 拿短期凭证 → 浏览器直传 S3 → 返回 key。
 * 用 XHR 而非 fetch：上传进度百分比（US-01）只有 XHR 提供。
 */
export async function uploadFile(
  blob: Blob,
  type: 'photo' | 'voice' | 'video',
  onProgress?: (percent: number) => void,
): Promise<{ key: string }> {
  const presign = await api<PresignResponse>('/api/uploads/presign', {
    method: 'POST',
    body: JSON.stringify({ type, mimeType: blob.type, size: blob.size }),
  });

  await new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', presign.uploadUrl);
    xhr.timeout = 300_000;
    for (const [name, value] of Object.entries(presign.headers)) {
      xhr.setRequestHeader(name, value);
    }
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) {
        onProgress(Math.round((e.loaded / e.total) * 100));
      }
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        onProgress?.(100);
        resolve();
      } else {
        reject(new Error(`上传失败（HTTP ${xhr.status}）`));
      }
    };
    xhr.onerror = () => reject(new Error('网络异常，上传失败'));
    xhr.ontimeout = () => reject(new Error('上传超时，请重试'));
    xhr.send(blob);
  });

  return { key: presign.key };
}
