import { ApiErrorCode } from '@family-frame/shared';

/** API 调用错误：message 已映射为可直接展示给用户的中文文案 */
export class ApiError extends Error {
  readonly status: number;
  readonly code?: string;

  constructor(status: number, code: string | undefined, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

const FRIENDLY_MESSAGES: Record<string, string> = {
  [ApiErrorCode.BadRequest]: '发送内容不正确，请检查后重试',
  [ApiErrorCode.Unauthorized]: '请先登录',
  [ApiErrorCode.Forbidden]: '没有权限执行此操作',
  [ApiErrorCode.NotFound]: '内容不存在',
  [ApiErrorCode.RateLimited]: '操作太频繁，请稍后再试',
  [ApiErrorCode.StorageUnavailable]: '存储服务暂时不可用，请稍后再试',
  [ApiErrorCode.InternalError]: '服务器开小差了，请稍后再试',
};

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      credentials: 'same-origin',
      ...init,
      headers: {
        ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
        ...init?.headers,
      },
    });
  } catch {
    throw new ApiError(0, 'network_error', '网络异常，请检查网络后重试');
  }
  if (!res.ok) {
    if (res.status === 401 && path !== '/api/auth/login' && path !== '/api/auth/join') {
      window.dispatchEvent(new Event('ff-session-expired'));
    }
    let code: string | undefined;
    let message: string | undefined;
    try {
      const body = (await res.json()) as { error?: string; message?: string };
      code = body.error;
      message = body.message;
    } catch {
      // 非 JSON 错误体，使用默认文案
    }
    throw new ApiError(res.status, code, message ?? FRIENDLY_MESSAGES[code ?? ''] ?? '请求失败，请稍后重试');
  }
  return (await res.json()) as T;
}
