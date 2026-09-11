import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as dotenvConfig } from 'dotenv';

// 测试环境准备：
// 1. 若仓库根目录存在 .env 则加载（本地连真实 MySQL 时 /health/db 走真实 up 分支）；
// 2. 否则使用 docker-compose 默认连接串——MySQL 不在时 /health/db 如实走 down 分支。
const here = path.dirname(fileURLToPath(import.meta.url));
const rootEnv = path.resolve(here, '../../../.env');
if (existsSync(rootEnv)) {
  dotenvConfig({ path: rootEnv, quiet: true });
}

process.env.DATABASE_URL ??= 'mysql://root:family_frame_root@127.0.0.1:3306/family_frame';
