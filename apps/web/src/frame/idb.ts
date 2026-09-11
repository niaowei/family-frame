/**
 * 相框离线缓存：IndexedDB 层（M4）。
 *
 * DB：family-frame-offline（version 1）
 *   posts  (keyPath id, index createdAt)   —— post 元数据
 *   media  (keyPath id, index postId)      —— 照片/语音真实 Blob
 *   meta   (keyPath key)                   —— schemaVersion / lastSuccessfulSync / pendingEvents
 *
 * 原则：
 * - 只存真实 Blob，不存 signed URL / object URL / base64（URL.createObjectURL 仅显示阶段临时生成）；
 * - 升级通过 onupgradeneeded 增量建 store/index，旧数据保留；
 * - 打开失败 → 抛 IdbUnavailableError，调用方降级为纯在线模式（不白屏）；
 * - 读取对单条坏数据做防御（跳过），不让一条坏记录毁掉整个相框。
 */

export const FRAME_DB_NAME = 'family-frame-offline';
export const FRAME_DB_VERSION = 1;
export const KEEP_POSTS_DEFAULT = 30;

export type CachedMediaType = 'PHOTO' | 'VOICE' | 'VIDEO';

export interface CachedPostRow {
  id: string;
  memberName: string;
  messageText: string | null;
  /** epoch ms */
  createdAt: number;
  cachedAt: number;
  lastAccessedAt: number;
  hasVoice: boolean;
}

export interface CachedMediaRow {
  id: string;
  postId: string;
  type: CachedMediaType;
  blob: Blob;
  mimeType: string;
  cachedAt: number;
  lastAccessedAt: number;
}

export interface PendingFrameEvent {
  postId: string;
  event: 'seen' | 'heard';
}

export class IdbUnavailableError extends Error {
  constructor(reason: string) {
    super(`IndexedDB 不可用：${reason}`);
    this.name = 'IdbUnavailableError';
  }
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('indexeddb request failed'));
  });
}

function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error('indexeddb transaction aborted'));
    tx.onerror = () => reject(tx.error ?? new Error('indexeddb transaction failed'));
  });
}

let dbPromise: Promise<IDBDatabase> | null = null;

const REQUIRED_STORES = ['posts', 'media', 'meta'] as const;

function openRaw(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(FRAME_DB_NAME, FRAME_DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      // 增量升级：已存在的 store 不重建，旧数据保留（未来版本在此按 oldVersion 分支扩展）
      if (!db.objectStoreNames.contains('posts')) {
        const posts = db.createObjectStore('posts', { keyPath: 'id' });
        posts.createIndex('createdAt', 'createdAt');
      }
      if (!db.objectStoreNames.contains('media')) {
        const media = db.createObjectStore('media', { keyPath: 'id' });
        media.createIndex('postId', 'postId');
      }
      if (!db.objectStoreNames.contains('meta')) {
        db.createObjectStore('meta', { keyPath: 'key' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new IdbUnavailableError(request.error?.message ?? 'open failed'));
    request.onblocked = () => reject(new IdbUnavailableError('upgrade blocked（其他标签页占用旧版本）'));
  });
}

function hasAllStores(db: IDBDatabase): boolean {
  return REQUIRED_STORES.every((name) => db.objectStoreNames.contains(name));
}

function deleteDatabase(name: string): Promise<void> {
  return new Promise((resolve) => {
    const req = indexedDB.deleteDatabase(name);
    req.onsuccess = () => resolve();
    req.onerror = () => resolve();
    req.onblocked = () => resolve();
  });
}

async function openDb(): Promise<IDBDatabase> {
  if (typeof indexedDB === 'undefined') {
    throw new IdbUnavailableError('当前环境无 indexedDB');
  }
  if (dbPromise) return dbPromise;
  dbPromise = (async () => {
    let db = await openRaw();
    if (!hasAllStores(db)) {
      // 自愈（迁移失败的明确降级策略）：库结构不完整/损坏 → 重建。
      // 库内只有可再生缓存，重建不丢业务数据；随后所有 store 保证可用。
      db.onversionchange = null;
      db.close();
      await deleteDatabase(FRAME_DB_NAME);
      db = await openRaw();
      if (!hasAllStores(db)) {
        throw new IdbUnavailableError('recovery failed：重建后结构仍不完整');
      }
    }
    db.onversionchange = () => {
      db.close();
      dbPromise = null;
    };
    return db;
  })();
  dbPromise.catch(() => {
    dbPromise = null;
  });
  return dbPromise;
}

/** 打开失败/升级失败后的降级：调用方捕获 IdbUnavailableError 走纯在线模式 */
export async function tryOpenFrameDb(): Promise<IDBDatabase | null> {
  try {
    return await openDb();
  } catch {
    return null;
  }
}

export async function saveCachedPost(post: CachedPostRow, media: CachedMediaRow[]): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(['posts', 'media'], 'readwrite');
  const posts = tx.objectStore('posts');
  const mediaStore = tx.objectStore('media');
  posts.put(post);
  for (const row of media) mediaStore.put(row);
  await transactionDone(tx);
}

export async function getAllCachedPosts(): Promise<CachedPostRow[]> {
  const db = await openDb();
  const rows = await requestToPromise(db.transaction('posts').objectStore('posts').getAll());
  // 防御坏数据：缺 id / 非对象的行直接跳过
  return (rows as CachedPostRow[])
    .filter((r) => !!r && typeof r.id === 'string' && typeof r.createdAt === 'number')
    .sort((a, b) => b.createdAt - a.createdAt);
}

export async function getAllCachedMedia(): Promise<CachedMediaRow[]> {
  const db = await openDb();
  const rows = await requestToPromise(db.transaction('media').objectStore('media').getAll());
  return (rows as CachedMediaRow[]).filter((r) => !!r && typeof r.id === 'string' && r.blob instanceof Blob);
}

/** 读取单个媒体 Blob（触达即刷新 lastAccessedAt，失败静默） */
export async function getMediaBlob(mediaId: string): Promise<Blob | null> {
  const db = await openDb();
  const row = await requestToPromise(
    db.transaction('media').objectStore('media').get(mediaId),
  );
  const media = row as CachedMediaRow | undefined;
  if (!media || !(media.blob instanceof Blob)) return null;
  void db
    .transaction('media', 'readwrite')
    .objectStore('media')
    .put({ ...media, lastAccessedAt: Date.now() });
  return media.blob;
}

export async function getExistingMediaIds(): Promise<Set<string>> {
  const media = await getAllCachedMedia();
  return new Set(media.map((m) => m.id));
}

export async function getExistingPostIds(): Promise<Set<string>> {
  const posts = await getAllCachedPosts();
  return new Set(posts.map((p) => p.id));
}

/**
 * 淘汰：保留最新 keep 个 Post（按 createdAt 倒序），更旧的连同其全部 media 一起删除。
 * protectedIds（当前正在看/播放的 Post）不淘汰——宁可暂时超出 keep 数量。
 * 返回被淘汰的 postId 列表（调用方据此回收 objectURL/内存）。
 */
export async function evictOldPosts(
  keep: number = KEEP_POSTS_DEFAULT,
  protectedIds: string[] = [],
): Promise<string[]> {
  const db = await openDb();
  const tx = db.transaction(['posts', 'media'], 'readwrite');
  const postsStore = tx.objectStore('posts');
  const mediaStore = tx.objectStore('media');
  const mediaByPost = mediaStore.index('postId');

  const allPosts = (await requestToPromise(postsStore.getAll())) as CachedPostRow[];
  const sorted = allPosts
    .filter((p) => !!p && typeof p.id === 'string')
    .sort((a, b) => b.createdAt - a.createdAt);
  const protect = new Set(protectedIds);
  const toEvict = sorted.slice(keep).filter((p) => !protect.has(p.id));

  const evicted: string[] = [];
  for (const post of toEvict) {
    postsStore.delete(post.id);
    const mediaRows = (await requestToPromise(mediaByPost.getAll(post.id))) as CachedMediaRow[];
    for (const m of mediaRows) mediaStore.delete(m.id);
    evicted.push(post.id);
  }
  await transactionDone(tx);
  return evicted;
}

/** 删除单个 Post 及其全部媒体（原子） */
export async function deleteCachedPost(postId: string): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(['posts', 'media'], 'readwrite');
  tx.objectStore('posts').delete(postId);
  const mediaRows = (await requestToPromise(
    tx.objectStore('media').index('postId').getAll(postId),
  )) as CachedMediaRow[];
  for (const m of mediaRows) tx.objectStore('media').delete(m.id);
  await transactionDone(tx);
}

export async function setMeta(key: string, value: unknown): Promise<void> {
  const db = await openDb();
  const tx = db.transaction('meta', 'readwrite');
  tx.objectStore('meta').put({ key, value });
  await transactionDone(tx);
}

export async function getMeta<T>(key: string): Promise<T | null> {
  const db = await openDb();
  const row = await requestToPromise(db.transaction('meta').objectStore('meta').get(key));
  const record = row as { key: string; value: T } | undefined;
  return record ? record.value : null;
}

/**
 * seen/heard 离线待补报（最小实现，幂等）：
 * - seen：同一 post 只保留一条；
 * - heard：同一 post 覆盖为最新一条；
 * - 已上报成功的事件由 flush 移除。
 */
export async function queuePendingFrameEvent(postId: string, event: 'seen' | 'heard'): Promise<void> {
  const pending = (await getMeta<PendingFrameEvent[]>('pendingEvents')) ?? [];
  const withoutPostHeard = pending.filter(
    (p) => !(p.postId === postId && p.event === 'heard'),
  );
  if (event === 'heard') {
    withoutPostHeard.push({ postId, event });
  } else if (!withoutPostHeard.some((p) => p.postId === postId && p.event === 'seen')) {
    withoutPostHeard.push({ postId, event });
  }
  await setMeta('pendingEvents', withoutPostHeard);
}

export async function getPendingFrameEvents(): Promise<PendingFrameEvent[]> {
  return (await getMeta<PendingFrameEvent[]>('pendingEvents')) ?? [];
}

export async function setPendingFrameEvents(pending: PendingFrameEvent[]): Promise<void> {
  await setMeta('pendingEvents', pending);
}

/** 测试辅助：彻底删除数据库（真实浏览器代码不调用） */
export async function deleteFrameDbForTests(): Promise<void> {
  dbPromise = null;
  if (typeof indexedDB === 'undefined') return;
  await new Promise<void>((resolve) => {
    const req = indexedDB.deleteDatabase(FRAME_DB_NAME);
    req.onsuccess = () => resolve();
    req.onerror = () => resolve();
    req.onblocked = () => resolve();
  });
}
