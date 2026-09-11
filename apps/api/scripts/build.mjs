import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

// 打包 API：业务代码 + @family-frame/shared 打入 dist，
// node_modules（express/prisma client 等含原生模块）保持 external。
const apiDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

await esbuild.build({
  entryPoints: [path.join(apiDir, 'src', 'index.ts')],
  outfile: path.join(apiDir, 'dist', 'index.js'),
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  packages: 'external',
  sourcemap: true,
  logLevel: 'info',
  alias: {
    '@family-frame/shared': path.resolve(apiDir, '..', '..', 'packages', 'shared', 'src', 'index.ts'),
  },
});
