/**
 * @family-frame/shared
 * 家人端 / 相框端 / API 共用的类型与常量。
 * 业务类型随对应里程碑补充（M2：认证与帖子/媒体）。
 */

export const APP_NAME = '家里来照片了' as const;
/** 生产镜像版本（PRD §23：健康检查可暴露，不含任何 secret） */
export const APP_VERSION = '0.2.1' as const;

/** 通用 API 错误码（服务端返回 JSON 的 error 字段） */
export const ApiErrorCode = {
  BadRequest: 'bad_request',
  Unauthorized: 'unauthorized',
  Forbidden: 'forbidden',
  NotFound: 'not_found',
  RateLimited: 'rate_limited',
  StorageUnavailable: 'storage_unavailable',
  InternalError: 'internal_error',
} as const;

export type ApiErrorCode = (typeof ApiErrorCode)[keyof typeof ApiErrorCode];

/** 服务端错误响应统一形状 */
export interface ApiErrorResponse {
  error: ApiErrorCode;
  message?: string;
  requestId?: string;
}

/** GET /health 响应 */
export interface HealthResponse {
  status: 'ok';
  app: string;
  version: string;
  uptimeSeconds: number;
  timestamp: string;
}

/** GET /health/db 响应（数据库连通性，供管理员诊断；不含连接串/主机等敏感细节） */
export interface HealthDbResponse {
  status: 'ok' | 'error';
  database: 'up' | 'down';
  latencyMs: number | null;
  error?: string;
}

// ---------- M2：认证与帖子 ----------

export type MemberRole = 'ADMIN' | 'MEMBER';

/** 登录成功的成员信息（不含任何敏感字段） */
export interface MemberProfile {
  id: string;
  familyId: string;
  displayName: string;
  role: MemberRole;
}

/** POST /api/uploads/presign 响应 */
export interface PresignResponse {
  key: string;
  uploadUrl: string;
  expiresInSec: number;
  headers: Record<string, string>;
}

export type MediaType = 'PHOTO' | 'VOICE' | 'VIDEO';

/** history 里的媒体条目（objectKey 不下发，展示走 /api/media/:id 302） */
export interface MediaItem {
  id: string;
  type: MediaType;
  mimeType: string;
  durationMs: number | null;
}

/** GET /api/posts 列表项 */
export interface PostSummary {
  id: string;
  messageText: string | null;
  createdAt: string;
  member: { id: string; displayName: string };
  media: MediaItem[];
}

export interface HistoryResponse {
  posts: PostSummary[];
  yesterdayPhotoCount: number;
  pendingPostCount: number;
}

// ---------- M3：相框端 ----------

/** 相框 feed 内的媒体条目（objectKey 不下发；媒体经 /api/frame/media/:id 302 预签名访问） */
export interface FrameFeedMedia {
  id: string;
  type: MediaType;
  mimeType: string;
  durationMs: number | null;
}

/** GET /api/frame/feed 列表项（createdAt 倒序，最新在前） */
export interface FrameFeedPost {
  id: string;
  messageText: string | null;
  createdAt: string;
  member: { displayName: string };
  media: FrameFeedMedia[];
}

export interface FrameFeedResponse {
  posts: FrameFeedPost[];
  /** 最新的 postId，可作下一次 after 游标 */
  cursor: string | null;
  serverTime: string;
}
