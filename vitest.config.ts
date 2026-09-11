import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['apps/*/tests/**/*.test.ts', 'packages/*/tests/**/*.test.ts'],
    setupFiles: ['apps/api/tests/setup.ts'],
    testTimeout: 15000,
    // 单进程顺序执行：集成测试共享真实 MySQL/MinIO，避免并发 worker 崩溃与数据竞争
    pool: 'forks',
    poolOptions: {
      forks: { singleFork: true },
    },
  },
});
