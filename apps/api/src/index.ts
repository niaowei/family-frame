import crypto from 'node:crypto';
import { createApp } from './app';
import { loadEnv } from './config/env';
import { createS3 } from './lib/s3';
import { prisma } from './db/prisma';
import { scheduleCloudCleanup } from './lib/cloudCleanup';

function main(): void {
  let config;
  try {
    config = loadEnv();
  } catch (err) {
    // 环境变量校验失败：打印明确原因后退出，不带着错误配置继续跑
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  // SESSION_SECRET：production 缺失即启动失败（env 校验已拦截，此处为显式兜底，禁止随机 fallback）；
  // 随机 fallback 仅允许出现在 development/test，且必须明确告警。
  let sessionSecret = config.sessionSecret;
  if (!sessionSecret) {
    if (config.nodeEnv === 'production') {
      console.error('SESSION_SECRET 缺失：生产环境禁止启动');
      process.exit(1);
    }
    sessionSecret = crypto.randomBytes(32).toString('hex');
    console.warn(
      JSON.stringify({ msg: 'SESSION_SECRET 未设置：本次启动使用随机值，重启后所有登录状态将失效' }),
    );
  }

  // DEVICE_TOKEN_PEPPER 同理：生产必填（env 校验），开发缺失时用本次启动随机值并告警
  let deviceTokenPepper = config.deviceTokenPepper;
  if (!deviceTokenPepper) {
    if (config.nodeEnv === 'production') {
      console.error('DEVICE_TOKEN_PEPPER 缺失：生产环境禁止启动');
      process.exit(1);
    }
    deviceTokenPepper = crypto.randomBytes(32).toString('hex');
    console.warn(
      JSON.stringify({ msg: 'DEVICE_TOKEN_PEPPER 未设置：本次启动使用随机值，seed 的设备 token 将失效' }),
    );
  }

  const s3 = createS3(config.s3);
  if (!s3 && config.nodeEnv !== 'test') {
    console.warn(
      JSON.stringify({ msg: 'S3 未配置：上传相关接口将返回 503（本地开发请启动 docker compose 里的 MinIO）' }),
    );
  }

  const app = createApp({
    nodeEnv: config.nodeEnv,
    sessionSecret,
    deviceTokenPepper,
    prisma,
    s3,
    webDistDir: config.webDistDir,
  });
  const stopCloudCleanup = config.cloudCleanupEnabled && s3 ? scheduleCloudCleanup({ prisma, s3 }) : null;
  const server = app.listen(config.port, () => {
    console.log(
      JSON.stringify({
        msg: 'api listening',
        port: config.port,
        nodeEnv: config.nodeEnv,
        s3: s3 ? 'configured' : 'missing',
      }),
    );
  });

  const shutdown = (signal: string): void => {
    console.log(JSON.stringify({ msg: 'shutting down', signal }));
    stopCloudCleanup?.();
    server.close(() => process.exit(0));
    // 兜底：5 秒内没退完就强制退出
    setTimeout(() => process.exit(1), 5000).unref();
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main();
