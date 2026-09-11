import type { FrameFeedPost, FrameFeedResponse } from '@family-frame/shared';
import type { CachedMediaRow, CachedPostRow, PendingFrameEvent } from './idb';
import * as idb from './idb';
import { KEEP_POSTS_DEFAULT } from './idb';

/**
 * 离线缓存同步编排（M4）。
 *
 * 铁律：
 * 1. 先成功写入新内容，再执行淘汰——绝不出现"旧的已删、新的没存上"；
 * 2. 单个媒体失败只跳过该媒体，不阻塞其他 Post；没有任何照片成功缓存的 Post 不进入离线 feed；
 *    失败的媒体下一轮同步自动重试（只下载缺失的）；
 * 3. 配额超限：淘汰最旧后重试一次，再失败则停止本轮媒体缓存（在线浏览不受影响，不无限重试）；
 * 4. 当前正在看/播放的 Post 受保护，不淘汰。
 */

/** 存储操作接口：默认绑定 IndexedDB 模块；测试注入内存实现 */
export interface SyncStore {
  getExistingPostIds(): Promise<Set<string>>;
  getExistingMediaIds(): Promise<Set<string>>;
  saveCachedPost(post: CachedPostRow, media: CachedMediaRow[]): Promise<void>;
  evictOldPosts(keep: number, protectedIds: string[]): Promise<string[]>;
  getPendingFrameEvents(): Promise<PendingFrameEvent[]>;
  setPendingFrameEvents(pending: PendingFrameEvent[]): Promise<void>;
  getMeta<T>(key: string): Promise<T | null>;
  setMeta(key: string, value: unknown): Promise<void>;
}

const defaultStore: SyncStore = {
  getExistingPostIds: () => idb.getExistingPostIds(),
  getExistingMediaIds: () => idb.getExistingMediaIds(),
  saveCachedPost: (post, media) => idb.saveCachedPost(post, media),
  evictOldPosts: (keep, protectedIds) => idb.evictOldPosts(keep, protectedIds),
  getPendingFrameEvents: () => idb.getPendingFrameEvents(),
  setPendingFrameEvents: (pending) => idb.setPendingFrameEvents(pending),
  getMeta: <T,>(key: string) => idb.getMeta<T>(key),
  setMeta: (key, value) => idb.setMeta(key, value),
};

export interface SyncDeps {
  fetchFeed: () => Promise<FrameFeedResponse>;
  fetchMediaBlob: (mediaId: string) => Promise<Blob>;
  /** 当前正在看/播放的 postId（淘汰保护） */
  protectedPostIds: () => string[];
  /** 补报 seen/heard（网络发送）；失败抛错则保留待补报 */
  sendEvent: (pending: PendingFrameEvent) => Promise<void>;
  keepCount?: number;
  now?: () => number;
  /** 默认 IndexedDB；测试可注入内存实现 */
  store?: SyncStore;
}

export interface SyncResult {
  /** 成功写入/更新的 postId */
  cachedPosts: string[];
  /** 下载失败的 mediaId（下一轮重试） */
  failedMedia: string[];
  /** 因无照片成功缓存而未进入离线 feed 的 postId */
  skippedPosts: string[];
  evictedPosts: string[];
  quotaExceeded: boolean;
  flushedEvents: number;
}

export function isQuotaError(err: unknown): boolean {
  return (
    err instanceof DOMException &&
    (err.name === 'QuotaExceededError' || err.name === 'NS_ERROR_DOM_QUOTA_REACHED')
  );
}

/** feed 内容指纹：length + 最新 id 变化才需要重新同步媒体 */
export function computeFeedKey(feed: FrameFeedResponse | null): string | null {
  if (!feed || feed.posts.length === 0) return null;
  return `${feed.posts.length}:${feed.posts[0]?.id ?? ''}`;
}

export function shouldSyncCache(input: {
  feedKey: string | null;
  lastSyncedFeedKey: string | null;
  pendingEventCount: number;
  hasFailedMedia: boolean;
}): boolean {
  if (input.feedKey === null) return false;
  if (input.lastSyncedFeedKey !== input.feedKey) return true;
  if (input.pendingEventCount > 0) return true;
  return input.hasFailedMedia;
}

function toPostRow(post: FrameFeedPost, now: number): CachedPostRow {
  return {
    id: post.id,
    memberName: post.member.displayName,
    messageText: post.messageText,
    createdAt: Date.parse(post.createdAt),
    cachedAt: now,
    lastAccessedAt: now,
    hasVoice: post.media.some((m) => m.type === 'VOICE'),
  };
}

export async function syncOfflineCache(deps: SyncDeps): Promise<SyncResult> {
  const now = deps.now ?? (() => Date.now());
  const keep = deps.keepCount ?? KEEP_POSTS_DEFAULT;
  const store = deps.store ?? defaultStore;
  const result: SyncResult = {
    cachedPosts: [],
    failedMedia: [],
    skippedPosts: [],
    evictedPosts: [],
    quotaExceeded: false,
    flushedEvents: 0,
  };

  const feed = await deps.fetchFeed(); // 失败由调用方处理（本轮不同步）

  const existingPosts = await store.getExistingPostIds();
  const existingMedia = await store.getExistingMediaIds();

  for (const post of feed.posts) {
    if (result.quotaExceeded) {
      // 配额已超限：停止本轮媒体缓存，剩余媒体下一轮重试
      continue;
    }
    const missing = post.media.filter((m) => !existingMedia.has(m.id));
    if (missing.length === 0 && existingPosts.has(post.id)) {
      continue; // 已完整缓存
    }

    const downloaded: CachedMediaRow[] = [];
    for (const media of missing) {
      try {
        const blob = await deps.fetchMediaBlob(media.id);
        if (!(blob instanceof Blob) || blob.size === 0) throw new Error('empty blob');
        downloaded.push({
          id: media.id,
          postId: post.id,
          type: media.type,
          blob,
          mimeType: media.mimeType,
          cachedAt: now(),
          lastAccessedAt: now(),
        });
      } catch {
        result.failedMedia.push(media.id);
      }
    }

    // 部分失败策略：至少一张核心照片成功缓存（或此前已有照片缓存）才保存 Post；
    // 照片全部失败时丢弃本轮已下载的语音（下一轮随照片一起重下），避免产生无 Post 行的孤儿媒体
    const hasPhotoCached =
      downloaded.some((m) => m.type === 'PHOTO' || m.type === 'VIDEO') ||
      post.media.some((m) => (m.type === 'PHOTO' || m.type === 'VIDEO') && existingMedia.has(m.id));
    if (!hasPhotoCached) {
      result.skippedPosts.push(post.id);
      continue;
    }
    if (downloaded.length === 0) {
      continue; // 无新增媒体且 Post 行已在库
    }

    try {
      await store.saveCachedPost(toPostRow(post, now()), downloaded);
      result.cachedPosts.push(post.id);
      for (const m of downloaded) existingMedia.add(m.id);
      existingPosts.add(post.id);
    } catch (err) {
      if (isQuotaError(err)) {
        // 淘汰最旧（保留一半，仍保护当前）后重试一次
        await store.evictOldPosts(Math.max(5, Math.floor(keep / 2)), deps.protectedPostIds()).catch(
          () => undefined,
        );
        try {
          await store.saveCachedPost(toPostRow(post, now()), downloaded);
          result.cachedPosts.push(post.id);
          for (const m of downloaded) existingMedia.add(m.id);
          existingPosts.add(post.id);
        } catch {
          result.quotaExceeded = true; // 仍失败：停止本轮媒体缓存
        }
      } else {
        result.failedMedia.push(...downloaded.map((m) => m.id));
      }
    }
  }

  // 淘汰在全部保存成功之后执行；当前 Post 受保护
  if (!result.quotaExceeded) {
    result.evictedPosts = await store.evictOldPosts(keep, deps.protectedPostIds()).catch(() => []);
  }

  // 补报离线期间的 seen/heard（best-effort，逐条发送，成功的移除）
  const pending = await store.getPendingFrameEvents();
  if (pending.length > 0) {
    const remaining: PendingFrameEvent[] = [];
    for (const event of pending) {
      try {
        await deps.sendEvent(event);
        result.flushedEvents += 1;
      } catch {
        remaining.push(event);
      }
    }
    await store.setPendingFrameEvents(remaining).catch(() => undefined);
  }

  await store.setMeta('lastSuccessfulSync', new Date(now()).toISOString()).catch(() => undefined);
  return result;
}

export async function getLastSyncedFeedKey(): Promise<string | null> {
  return idb.getMeta<string>('lastSyncedFeedKey');
}

export async function setLastSyncedFeedKey(key: string): Promise<void> {
  await idb.setMeta('lastSyncedFeedKey', key);
}
