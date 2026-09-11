import { CreateBucketCommand, HeadBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { config as dotenvConfig } from 'dotenv';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// 确保对象存储 bucket 存在（S3/MinIO 的 bucket 创建后默认 private，符合 PRD §10）。
// 服务端 bucket 操作走 INTERNAL endpoint（Sealos 内网优先）。
// 用法：npm run s3:init
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const envFile = path.join(root, '.env');
if (existsSync(envFile)) dotenvConfig({ path: envFile, quiet: true });

const endpoint = process.env.S3_INTERNAL_ENDPOINT ?? process.env.S3_ENDPOINT;
const bucket = process.env.S3_BUCKET;
if (!endpoint || !bucket || !process.env.S3_ACCESS_KEY || !process.env.S3_SECRET_KEY) {
  console.error('S3_* 环境变量不完整，请先配置 .env（参考 .env.example）');
  process.exit(1);
}

const client = new S3Client({
  endpoint,
  region: process.env.S3_REGION || 'us-east-1',
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY,
    secretAccessKey: process.env.S3_SECRET_KEY,
  },
  forcePathStyle: true,
});

try {
  try {
    await client.send(new HeadBucketCommand({ Bucket: bucket }));
    console.log(`bucket "${bucket}" 已存在`);
  } catch (err) {
    const status = err?.$metadata?.httpStatusCode;
    if (status === 404 || status === 301 || err.name === 'NoSuchBucket') {
      await client.send(new CreateBucketCommand({ Bucket: bucket }));
      console.log(`bucket "${bucket}" 已创建（private）`);
    } else {
      throw err;
    }
  }
  process.exit(0);
} catch (err) {
  console.error('创建 bucket 失败：', err instanceof Error ? err.message : err);
  process.exit(1);
}
