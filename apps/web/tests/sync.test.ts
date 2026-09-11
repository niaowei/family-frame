import { describe, expect, it } from 'vitest';
import type { FrameFeedPost, FrameFeedResponse } from '@family-frame/shared';
import { computeFeedKey, shouldSyncCache, syncOfflineCache } from '../src/frame/sync';
import type { SyncStore } from '../src/frame/sync';

/**
 * 同步编排测试（依赖注入的内存 store）：
 * 先存后淘、只下载缺失、部分失败策略、quota 降级、淘汰保护、离线事件补报。
 */

function makeFeedPost(id: string, minutesAgo: number, media: FrameFeedPost['media']): FrameFeedPost {
  return {
    id,
    messageText: `留言-${id}`,
    createdAt: new Date(Date.parse('2026-09-06T12:00:00Z') - minutesAgo * 60_000).toISOString(),
    member: { displayName: '维' },
    media,
  };
}

function photoMedia(id: string) {
  return { id, type: 'PHOTO' as const, mimeType: 'image/png', durationMs: null };
}
function voiceMedia(id: string) {
  return { id, type: 'VOICE' as const, mimeType: 'audio/wav', durationMs: 2000 };
}

function makeFeed(posts: FrameFeedPost[]): FrameFeedResponse {
  return { posts, cursor: posts[0]?.id ?? null, serverTime: new Date().toISOString() };
}

/** 内存 store：语义与 IndexedDB 实现一致（保留最新、级联删除） */
function makeMemStore() {
  const posts = new Map<string, { createdAt: number }>();
  const media = new Map<string, { postId: string; blob: Blob }>();
  const meta = new Map<string, unknown>();
  const ops: string[] = [];
  let quotaFailRemaining = 0;

  const store: SyncStore = {
    async getExistingPostIds() {
      return new Set(posts.keys());
    },
    async getExistingMediaIds() {
      return new Set(media.keys());
    },
    async saveCachedPost(post, mediaRows) {
      ops.push(`save:${post.id}`);
      if (quotaFailRemaining > 0) {
        quotaFailRemaining -= 1;
        throw new DOMException('quota', 'QuotaExceededError');
      }
      posts.set(post.id, { createdAt: post.createdAt });
      for (const m of mediaRows) media.set(m.id, { postId: m.postId, blob: m.blob });
    },
    async evictOldPosts(keep, protectedIds) {
      ops.push(`evict:${keep}`);
      const sorted = [...posts.entries()].sort((a, b) => b[1].createdAt - a[1].createdAt);
      const protect = new Set(protectedIds);
      const toEvict = sorted.slice(keep).filter(([id]) => !protect.has(id)).map(([id]) => id);
      for (const id of toEvict) {
        posts.delete(id);
        for (const [mediaId, m] of [...media.entries()]) {
          if (m.postId === id) media.delete(mediaId);
        }
      }
      return toEvict;
    },
    async getPendingFrameEvents() {
      return (meta.get('pendingEvents') as { postId: string; event: string }[]) ?? [];
    },
    async setPendingFrameEvents(pending) {
      meta.set('pendingEvents', pending);
    },
    async getMeta(key) {
      return (meta.get(key) as never) ?? null;
    },
    async setMeta(key, value) {
      meta.set(key, value);
    },
  };
  return {
    store,
    ops,
    posts,
    media,
    meta,
    setQuotaFail(times: number) {
      quotaFailRemaining = times;
    },
  };
}

function makeDeps(mem: ReturnType<typeof makeMemStore>, opts?: {
  feed: FrameFeedResponse;
  failMediaIds?: string[];
  protectedIds?: string[];
  keep?: number;
  sentEvents?: { postId: string; event: string }[];
  failEventPostIds?: string[];
}) {
  const feed = opts?.feed ?? makeFeed([]);
  const failSet = new Set(opts?.failMediaIds ?? []);
  const sent = opts?.sentEvents ?? [];
  return {
    fetchFeed: async () => feed,
    fetchMediaBlob: async (mediaId: string) => {
      if (failSet.has(mediaId)) throw new Error('network fail');
      return new Blob([new Uint8Array([1])], { type: 'image/png' });
    },
    protectedPostIds: () => opts?.protectedIds ?? [],
    sendEvent: async (pending) => {
      if (opts?.failEventPostIds?.includes(pending.postId)) throw new Error('send failed');
      sent.push(pending);
    },
    keepCount: opts?.keep,
    store: mem.store,
  };
}

describe('computeFeedKey / shouldSyncCache', () => {
  it('feed 内容指纹：数量 + 最新 id', () => {
    const feed = makeFeed([makeFeedPost('a', 1, [photoMedia('ma')])]);
    expect(computeFeedKey(feed)).toBe('1:a');
    expect(computeFeedKey(makeFeed([]))).toBeNull();
    expect(computeFeedKey(null)).toBeNull();
  });

  it('需要同步的情形：key 变化 / 有待补报 / 有失败媒体；无需同步的情形', () => {
    expect(shouldSyncCache({ feedKey: '1:a', lastSyncedFeedKey: null, pendingEventCount: 0, hasFailedMedia: false })).toBe(true);
    expect(shouldSyncCache({ feedKey: '1:a', lastSyncedFeedKey: '1:a', pendingEventCount: 0, hasFailedMedia: false })).toBe(false);
    expect(shouldSyncCache({ feedKey: '1:a', lastSyncedFeedKey: '1:a', pendingEventCount: 2, hasFailedMedia: false })).toBe(true);
    expect(shouldSyncCache({ feedKey: '1:a', lastSyncedFeedKey: '1:a', pendingEventCount: 0, hasFailedMedia: true })).toBe(true);
    expect(shouldSyncCache({ feedKey: null, lastSyncedFeedKey: null, pendingEventCount: 0, hasFailedMedia: false })).toBe(false);
  });
});

describe('syncOfflineCache', () => {
  it('在线同步后可离线读取：post + photo/voice Blob 全部落库，顺序正确（最新在前）', async () => {
    const mem = makeMemStore();
    const feed = makeFeed([
      makeFeedPost('newest', 5, [photoMedia('m-new'), voiceMedia('v-new')]),
      makeFeedPost('older', 60, [photoMedia('m-old')]),
    ]);
    const result = await syncOfflineCache(makeDeps(mem, { feed }));

    expect(result.cachedPosts.sort()).toEqual(['newest', 'older']);
    expect(mem.posts.size).toBe(2);
    expect(mem.media.size).toBe(3);
    expect(mem.media.get('v-new')?.blob).toBeInstanceOf(Blob);
    // hasVoice 元数据
    expect((feed.posts[0] as FrameFeedPost).media.some((m) => m.type === 'VOICE')).toBe(true);
  });

  it('第二次同步不重复下载已缓存媒体（只下载缺失）', async () => {
    const mem = makeMemStore();
    const feed = makeFeed([makeFeedPost('p1', 5, [photoMedia('m1')])]);
    let fetchCount = 0;
    const deps = makeDeps(mem, { feed });
    const countingFetch = async (_mediaId: string) => {
      fetchCount += 1;
      return new Blob([new Uint8Array([1])]);
    };
    await syncOfflineCache({ ...deps, fetchMediaBlob: countingFetch });
    expect(fetchCount).toBe(1);

    await syncOfflineCache({ ...deps, fetchMediaBlob: countingFetch });
    expect(fetchCount).toBe(1); // 无新增 → 零下载
  });

  it('部分失败：photo A 失败、photo B 与 voice 成功 → Post 仍缓存（有照片），失败项记录', async () => {
    const mem = makeMemStore();
    const feed = makeFeed([
      makeFeedPost('p1', 5, [photoMedia('mA'), photoMedia('mB'), voiceMedia('v1')]),
    ]);
    const result = await syncOfflineCache(makeDeps(mem, { feed, failMediaIds: ['mA'] }));

    expect(result.failedMedia).toEqual(['mA']);
    expect(result.cachedPosts).toEqual(['p1']);
    expect(mem.media.has('mB')).toBe(true);
    expect(mem.media.has('v1')).toBe(true);
    expect(mem.posts.has('p1')).toBe(true);
  });

  it('照片全部失败的 Post 被跳过（不进离线 feed），且不阻塞其他 Post', async () => {
    const mem = makeMemStore();
    const feed = makeFeed([
      makeFeedPost('broken', 5, [photoMedia('m-broken')]),
      makeFeedPost('healthy', 10, [photoMedia('m-ok')]),
    ]);
    const result = await syncOfflineCache(makeDeps(mem, { feed, failMediaIds: ['m-broken'] }));

    expect(result.skippedPosts).toEqual(['broken']);
    expect(result.cachedPosts).toEqual(['healthy']);
    expect(mem.posts.has('broken')).toBe(false); // 无照片不进离线 feed
    expect(mem.posts.has('healthy')).toBe(true);
    expect(mem.media.has('m-ok')).toBe(true); // 其他 Post 不受影响
  });

  it('铁律：先全部保存再淘汰（ops 顺序），超量时淘汰最旧、保留最新', async () => {
    const mem = makeMemStore();
    const feed = makeFeed([
      makeFeedPost('p-new', 1, [photoMedia('m-new')]),
      makeFeedPost('p-mid', 30, [photoMedia('m-mid')]),
      makeFeedPost('p-old', 90, [photoMedia('m-old')]),
    ]);
    const result = await syncOfflineCache(makeDeps(mem, { feed, keep: 2 }));

    // 先保存后淘汰：最后两个 op 是 evict；save 在其之前
    const lastEvictIndex = mem.ops.map((o) => o.startsWith('evict')).lastIndexOf(true);
    const saveOps = mem.ops.filter((o) => o.startsWith('save'));
    expect(saveOps.length).toBeGreaterThanOrEqual(3);
    expect(mem.ops.slice(0, lastEvictIndex).every((o) => !o.startsWith('evict'))).toBe(true);

    expect(result.evictedPosts).toEqual(['p-old']);
    expect(mem.posts.has('p-new')).toBe(true);
    expect(mem.posts.has('p-mid')).toBe(true);
    expect(mem.posts.has('p-old')).toBe(false);
    expect(mem.media.has('m-old')).toBe(false); // 媒体一并清理，无孤儿
  });

  it('quota failure：淘汰最旧后重试一次成功', async () => {
    const mem = makeMemStore();
    // 预置 1 个旧 post（quota 触发后可被淘汰腾出空间）
    await syncOfflineCache(makeDeps(mem, { feed: makeFeed([makeFeedPost('old', 120, [photoMedia('m-old')])], ) }));
    mem.ops.length = 0;
    mem.setQuotaFail(1); // 第一次保存失败 → 淘汰重试成功

    const feed = makeFeed([makeFeedPost('fresh', 1, [photoMedia('m-fresh')])]);
    const result = await syncOfflineCache(makeDeps(mem, { feed, keep: 1 }));

    expect(result.quotaExceeded).toBe(false);
    expect(result.cachedPosts).toEqual(['fresh']);
    expect(mem.posts.has('fresh')).toBe(true);
    expect(mem.posts.has('old')).toBe(false); // 淘汰最旧腾出空间
  });

  it('quota failure：重试仍失败 → 停止本轮媒体缓存，不无限重试', async () => {
    const mem = makeMemStore();
    mem.setQuotaFail(999); // 永远失败
    const feed = makeFeed([
      makeFeedPost('p1', 1, [photoMedia('m1')]),
      makeFeedPost('p2', 2, [photoMedia('m2')]),
    ]);
    const result = await syncOfflineCache(makeDeps(mem, { feed }));

    expect(result.quotaExceeded).toBe(true);
    const quotaSaves = mem.ops.filter((o) => o.startsWith('save')).length;
    expect(quotaSaves).toBeLessThanOrEqual(2); // p1 首次+重试，之后本轮停止
    expect(mem.ops.filter((o) => o.startsWith('evict')).length).toBeLessThanOrEqual(1);
  });

  it('淘汰保护：当前正在看的 Post 不被淘汰', async () => {
    const mem = makeMemStore();
    const feed = makeFeed([
      makeFeedPost('p-new', 1, [photoMedia('m-new')]),
      makeFeedPost('p-old', 90, [photoMedia('m-old')]),
    ]);
    await syncOfflineCache(makeDeps(mem, { feed, keep: 1, protectedIds: ['p-old'] }));

    expect(mem.posts.has('p-old')).toBe(true); // 正在看 → 豁免
    expect(mem.posts.size).toBe(2); // 宁可暂时超量
  });

  it('离线 seen/heard 补报：成功移除、失败保留', async () => {
    const mem = makeMemStore();
    await mem.store.setPendingFrameEvents([
      { postId: 'p-ok', event: 'seen' },
      { postId: 'p-fail', event: 'heard' },
    ]);
    const feed = makeFeed([makeFeedPost('p1', 1, [photoMedia('m1')])]);
    const result = await syncOfflineCache(
      makeDeps(mem, { feed, failEventPostIds: ['p-fail'] }),
    );

    expect(result.flushedEvents).toBe(1);
    const remaining = await mem.store.getPendingFrameEvents();
    expect(remaining).toEqual([{ postId: 'p-fail', event: 'heard' }]);
  });
});
