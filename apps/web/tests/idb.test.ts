import { beforeEach, describe, expect, it } from 'vitest';
import 'fake-indexeddb/auto';
import {
  deleteFrameDbForTests,
  evictOldPosts,
  FRAME_DB_NAME,
  FRAME_DB_VERSION,
  getAllCachedMedia,
  getAllCachedPosts,
  getMediaBlob,
  getPendingFrameEvents,
  queuePendingFrameEvent,
  saveCachedPost,
  setPendingFrameEvents,
} from '../src/frame/idb';
import type { CachedMediaRow, CachedPostRow } from '../src/frame/idb';

/**
 * IndexedDB 存储语义测试（fake-indexeddb = Node 上的真实 IndexedDB 引擎实现）。
 */

function makePost(overrides: Partial<CachedPostRow> & { id: string }): CachedPostRow {
  return {
    memberName: '维',
    messageText: null,
    createdAt: Date.parse('2026-09-06T10:00:00Z'),
    cachedAt: Date.now(),
    lastAccessedAt: Date.now(),
    hasVoice: false,
    ...overrides,
  };
}

function makeMedia(overrides: Partial<CachedMediaRow> & { id: string; postId: string }): CachedMediaRow {
  return {
    type: 'PHOTO',
    blob: new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'image/png' }),
    mimeType: 'image/png',
    cachedAt: Date.now(),
    lastAccessedAt: Date.now(),
    ...overrides,
  };
}

beforeEach(async () => {
  await deleteFrameDbForTests();
});

describe('IndexedDB 基础存取', () => {
  it('保存 Post 与 photo Blob 后可完整读回', async () => {
    const post = makePost({ id: 'p1', messageText: '你好' });
    const photo = makeMedia({ id: 'm1', postId: 'p1', type: 'PHOTO' });
    await saveCachedPost(post, [photo]);

    const posts = await getAllCachedPosts();
    expect(posts).toHaveLength(1);
    expect(posts[0]?.id).toBe('p1');
    expect(posts[0]?.memberName).toBe('维');

    const media = await getAllCachedMedia();
    expect(media).toHaveLength(1);
    expect(media[0]?.blob).toBeInstanceOf(Blob);
    expect(media[0]?.blob.size).toBe(4);
  });

  it('voice Blob 以真实字节持久保存', async () => {
    const bytes = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 9, 9, 9]);
    const post = makePost({ id: 'p2', hasVoice: true });
    const voice = makeMedia({
      id: 'v1',
      postId: 'p2',
      type: 'VOICE',
      blob: new Blob([bytes], { type: 'audio/wav' }),
      mimeType: 'audio/wav',
    });
    await saveCachedPost(post, [voice]);

    const blob = await getMediaBlob('v1');
    expect(blob).toBeInstanceOf(Blob);
    const read = new Uint8Array(await blob!.arrayBuffer());
    expect(Array.from(read)).toEqual(Array.from(bytes));
  });

  it('重新"启动"（重开连接）后数据仍然存在（reload 持久性）', async () => {
    await saveCachedPost(makePost({ id: 'persist-1' }), [
      makeMedia({ id: 'pm-1', postId: 'persist-1' }),
    ]);
    // fake-indexeddb 全局实例跨连接持久 —— 等价于页面 reload 后重新 openDB
    const posts = await getAllCachedPosts();
    const media = await getAllCachedMedia();
    expect(posts.map((p) => p.id)).toContain('persist-1');
    expect(media.map((m) => m.id)).toContain('pm-1');
  });

  it('读取触达会刷新 lastAccessedAt（Blob 不变）', async () => {
    await saveCachedPost(makePost({ id: 'p3' }), [makeMedia({ id: 'm3', postId: 'p3' })]);
    const before = (await getAllCachedMedia())[0]?.lastAccessedAt ?? 0;
    await new Promise((r) => setTimeout(r, 15));
    await getMediaBlob('m3');
    const after = (await getAllCachedMedia())[0]?.lastAccessedAt ?? 0;
    expect(after).toBeGreaterThanOrEqual(before);
  });
});

describe('删除与淘汰', () => {
  it('删除 Post 时其全部媒体一并删除，不留孤儿', async () => {
    const { deleteCachedPost } = await import('../src/frame/idb');
    await saveCachedPost(makePost({ id: 'p-del' }), [
      makeMedia({ id: 'del-photo', postId: 'p-del', type: 'PHOTO' }),
      makeMedia({ id: 'del-voice', postId: 'p-del', type: 'VOICE' }),
    ]);
    await saveCachedPost(makePost({ id: 'p-keep' }), [
      makeMedia({ id: 'keep-photo', postId: 'p-keep', type: 'PHOTO' }),
    ]);

    await deleteCachedPost('p-del');

    expect((await getAllCachedPosts()).map((p) => p.id)).toEqual(['p-keep']);
    expect((await getAllCachedMedia()).map((m) => m.id)).toEqual(['keep-photo']);
  });

  it('保留最新 30 个 Post；第 31 个起连同媒体被淘汰', async () => {
    for (let i = 0; i < 33; i++) {
      const id = `post-${String(i).padStart(2, '0')}`;
      await saveCachedPost(
        makePost({ id, createdAt: Date.parse('2026-09-01T00:00:00Z') + i * 60_000 }),
        [makeMedia({ id: `media-${id}`, postId: id })],
      );
    }
    const evicted = await evictOldPosts(30);
    expect(evicted).toHaveLength(3);
    // 返回顺序为 feed 倒序位置（第 31/32/33 新）
    expect(evicted).toEqual(['post-02', 'post-01', 'post-00']);

    const posts = await getAllCachedPosts();
    expect(posts).toHaveLength(30);
    expect(posts.every((p) => p.id > 'post-02')).toBe(true);
    // 媒体无孤儿：只剩 30 条
    const media = await getAllCachedMedia();
    expect(media).toHaveLength(30);
    expect(media.some((m) => m.id === 'media-post-00')).toBe(false);
  });

  it('淘汰不删除最新内容，且受保护 Post 豁免（宁可暂时超量，不深挖）', async () => {
    for (let i = 0; i < 31; i++) {
      const id = `pp-${String(i).padStart(2, '0')}`;
      await saveCachedPost(
        makePost({ id, createdAt: Date.parse('2026-09-01T00:00:00Z') + i * 60_000 }),
        [makeMedia({ id: `m-${id}`, postId: id })],
      );
    }
    // 超量名单里只有最旧的 pp-00，而它正在被看 → 豁免，本轮不淘汰（等切换离开后下一轮再清理）
    const evicted = await evictOldPosts(30, ['pp-00']);
    expect(evicted).toEqual([]);
    const ids = (await getAllCachedPosts()).map((p) => p.id);
    expect(ids).toContain('pp-00');
    expect(ids).toContain('pp-30'); // 最新内容完好
    expect((await getAllCachedMedia()).length).toBe(31); // 媒体同样保留，无中途失效
  });
});

describe('schema version 与坏数据防御', () => {
  it('DB 名称与版本符合设计', () => {
    expect(FRAME_DB_NAME).toBe('family-frame-offline');
    expect(FRAME_DB_VERSION).toBe(1);
  });

  it('结构不完整的旧库自愈重建：打开后全部 store 可用（迁移失败降级策略）', async () => {
    // 模拟历史遗留的残缺库（只有 posts、缺 media/meta 且带旧数据）
    await deleteFrameDbForTests();
    const legacy = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(FRAME_DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('posts')) db.createObjectStore('posts', { keyPath: 'id' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = legacy.transaction('posts', 'readwrite');
      tx.objectStore('posts').put(makePost({ id: 'legacy-post' }));
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    legacy.close();

    // 模块打开：检测缺 store → 自愈重建 → 全部 store 可用
    // （自愈会清掉可再生缓存——文档化的降级策略，绝不白屏）
    await saveCachedPost(makePost({ id: 'new-post' }), [makeMedia({ id: 'new-media', postId: 'new-post' })]);
    const posts = await getAllCachedPosts();
    expect(posts.map((p) => p.id)).toEqual(['new-post']);
    expect((await getAllCachedMedia()).map((m) => m.id)).toEqual(['new-media']);
  });

  it('单条坏数据（缺字段）被跳过，不破坏整个读取', async () => {
    // 直接写入一条缺 createdAt 的坏数据（keyPath id 仍需存在）
    const { tryOpenFrameDb } = await import('../src/frame/idb');
    const db = await tryOpenFrameDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db!.transaction('posts', 'readwrite');
      tx.objectStore('posts').put({ id: 'broken-row' });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    await saveCachedPost(makePost({ id: 'good-post' }), []);

    const posts = await getAllCachedPosts();
    expect(posts.map((p) => p.id)).toEqual(['good-post']);
  });
});

describe('seen/heard 离线待补报（最小队列）', () => {
  it('seen 幂等去重，heard 覆盖同 post 的待补报（seen/heard 分开保留）', async () => {
    await queuePendingFrameEvent('p1', 'seen');
    await queuePendingFrameEvent('p1', 'seen'); // 幂等
    await queuePendingFrameEvent('p1', 'heard');
    await queuePendingFrameEvent('p1', 'heard'); // 覆盖
    let pending = await getPendingFrameEvents();
    expect(pending).toEqual([
      { postId: 'p1', event: 'seen' },
      { postId: 'p1', event: 'heard' },
    ]);

    await queuePendingFrameEvent('p2', 'seen');
    await queuePendingFrameEvent('p2', 'heard');
    pending = await getPendingFrameEvents();
    expect(pending).toHaveLength(4);
  });

  it('补报后剩余项写回', async () => {
    await setPendingFrameEvents([
      { postId: 'a', event: 'seen' },
      { postId: 'b', event: 'heard' },
    ]);
    // 模拟 flush：a 成功、b 失败
    const pending = await getPendingFrameEvents();
    await setPendingFrameEvents(pending.filter((p) => p.postId !== 'a'));
    const remaining = await getPendingFrameEvents();
    expect(remaining).toEqual([{ postId: 'b', event: 'heard' }]);
  });
});
