/**
 * feed 更新后的当前照片决策（新照片不抢屏）：
 * - 设备刚启动、此前没有任何照片 → 收到第一张直接展示；
 * - 已有照片（无论用户是否活跃、是否在播放）→ 新照片只进入 feed，不强制切换；
 *   用户 idle 后由自动轮播逐渐看到新照片；
 * - 当前照片被删除（feed 中不存在）→ 回到最新，避免停在失效内容上。
 */

export interface FeedApplyInput {
  /** 本次更新前是否已有照片（首启为 false） */
  hadPostsBefore: boolean;
  /** 当前展示的 postId（可为 null） */
  currentId: string | null;
  /** 更新后 feed 的最新 postId（feed 为空则为 null） */
  newestId: string | null;
  /** 更新后 feed 的全部 postId */
  postIdsInFeed: string[];
}

export function decideCurrentAfterFeedUpdate(input: FeedApplyInput): string | null {
  if (!input.newestId) return null;
  if (!input.hadPostsBefore) return input.newestId;
  if (input.currentId && input.postIdsInFeed.includes(input.currentId)) {
    return input.currentId;
  }
  return input.newestId;
}
