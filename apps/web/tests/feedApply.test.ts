import { describe, expect, it } from 'vitest';
import { decideCurrentAfterFeedUpdate } from '../src/frame/feedApply';

/**
 * 新照片不抢屏（M3 收尾）：
 * - 首启第一张直接展示；
 * - 已有照片时新照片只进 feed，不改变当前画面（无论活跃/播放中，均不打断）；
 * - 当前照片被删除时回最新。
 */
describe('decideCurrentAfterFeedUpdate', () => {
  it('设备刚启动：收到第一张照片直接展示', () => {
    const decision = decideCurrentAfterFeedUpdate({
      hadPostsBefore: false,
      currentId: null,
      newestId: 'post-1',
      postIdsInFeed: ['post-1'],
    });
    expect(decision).toBe('post-1');
  });

  it('已有照片：新照片到达不抢屏，保持当前画面（活跃用户）', () => {
    const decision = decideCurrentAfterFeedUpdate({
      hadPostsBefore: true,
      currentId: 'post-old',
      newestId: 'post-new', // 新照片已成为最新
      postIdsInFeed: ['post-new', 'post-old', 'post-older'],
    });
    expect(decision).toBe('post-old');
  });

  it('正在播放时同理：决策层只保持当前画面，播放自然不被打断', () => {
    // FramePage 中 currentId 不变 → 切换 effect 不触发 → PlaybackController.stop 不会被调用
    const decision = decideCurrentAfterFeedUpdate({
      hadPostsBefore: true,
      currentId: 'post-old',
      newestId: 'post-new',
      postIdsInFeed: ['post-new', 'post-old'],
    });
    expect(decision).toBe('post-old');
  });

  it('当前照片被删除 → 回到最新，不停留在失效内容', () => {
    const decision = decideCurrentAfterFeedUpdate({
      hadPostsBefore: true,
      currentId: 'post-deleted',
      newestId: 'post-new',
      postIdsInFeed: ['post-new', 'post-old'],
    });
    expect(decision).toBe('post-new');
  });

  it('feed 为空 → null（空态界面）', () => {
    const decision = decideCurrentAfterFeedUpdate({
      hadPostsBefore: true,
      currentId: 'post-old',
      newestId: null,
      postIdsInFeed: [],
    });
    expect(decision).toBeNull();
  });
});
