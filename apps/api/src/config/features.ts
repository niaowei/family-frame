/**
 * M2 功能开关（PRD §8 /history：「普通成员是否可删除自己的内容，可配置」）。
 * MVP 用代码内配置；需要运营侧调整时再挪到环境变量。
 */
export const features = {
  /** 普通成员是否可以删除自己发送的内容（管理员始终可以删除任意内容） */
  memberCanDeleteOwnPost: false,
} as const;
