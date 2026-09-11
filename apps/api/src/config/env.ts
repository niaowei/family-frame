import { existsSync } from 'node:fs';
import path from 'node:path';
import { config as dotenvConfig } from 'dotenv';
import { z } from 'zod';

/**
 * 环境变量校验（PRD §21）。
 * 启动即校验（fail fast）：缺配置、错格式直接拒绝启动，而不是运行中报错。
 * parseEnv 是纯函数，loadEnv 负责寻找并加载 .env 文件后调用它。
 */

const S3_CORE_FIELDS = ['S3_REGION', 'S3_BUCKET', 'S3_ACCESS_KEY', 'S3_SECRET_KEY'] as const;

const emptyToUndefined = (v: unknown): unknown =>
  typeof v === 'string' && v.trim() === '' ? undefined : v;

const optionalString = z.preprocess(emptyToUndefined, z.string().optional());

const urlLike = z.string().refine(
  (v) => {
    try {
      new URL(v);
      return true;
    } catch {
      return false;
    }
  },
  { message: 'PUBLIC_APP_URL 必须是合法 URL（含协议）' },
);

const optionalUrl = z.preprocess(emptyToUndefined, urlLike.optional());

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.preprocess(
      emptyToUndefined,
      z.coerce.number().int().min(1).max(65535).default(3000),
    ),
    DATABASE_URL: z
      .string({ error: 'DATABASE_URL 必填' })
      .min(1, 'DATABASE_URL 必填')
      .refine((v) => v.startsWith('mysql://'), {
        message: 'DATABASE_URL 必须是 mysql:// 开头的 MySQL 连接串',
      }),
    // S3（Sealos 对象存储）：M2 起真实使用，五个变量必须成套提供或全部留空（M1 仅预留）
    S3_ENDPOINT: optionalString,
    S3_REGION: optionalString,
    S3_BUCKET: optionalString,
    S3_ACCESS_KEY: optionalString,
    S3_SECRET_KEY: optionalString,
    // M5：双 endpoint——INTERNAL 供服务端操作（HeadObject/CopyObject/Delete），
    // PUBLIC 供生成浏览器可访问的 presigned PUT/GET。生产环境二者必填。
    S3_INTERNAL_ENDPOINT: optionalString,
    S3_PUBLIC_ENDPOINT: optionalString,
    // 生产静态托管目录（Docker 镜像内指向 apps/web/dist）；本地开发不设置
    WEB_DIST_DIR: optionalString,
    // M2 登录使用；生产环境必填
    SESSION_SECRET: optionalString,
    // M2 设备 token 加盐使用；生产环境必填
    DEVICE_TOKEN_PEPPER: optionalString,
    PUBLIC_APP_URL: optionalUrl,
    CLOUD_CLEANUP_ENABLED: z.preprocess((v) => v === 'true', z.boolean().default(false)),
  })
  .superRefine((env, ctx) => {
    // S3 配置规则（M5）：核心四项（REGION/BUCKET/AK/SK）成套；
    // endpoint 至少一个（S3_ENDPOINT 单地址 或 INTERNAL+PUBLIC 双地址）。
    const coreSet = S3_CORE_FIELDS.filter((f) => env[f] !== undefined);
    const hasAnyEndpoint =
      env.S3_ENDPOINT !== undefined ||
      env.S3_INTERNAL_ENDPOINT !== undefined ||
      env.S3_PUBLIC_ENDPOINT !== undefined;
    const s3Started = coreSet.length > 0 || hasAnyEndpoint;

    if (coreSet.length > 0 && coreSet.length < S3_CORE_FIELDS.length) {
      ctx.addIssue({
        code: 'custom',
        input: coreSet,
        message: 'S3_REGION/BUCKET/ACCESS_KEY/SECRET_KEY 必须成套提供或全部留空',
      });
    }
    if (s3Started && !(coreSet.length === S3_CORE_FIELDS.length && hasAnyEndpoint)) {
      ctx.addIssue({
        code: 'custom',
        input: coreSet,
        message: 'S3 密钥与 endpoint（S3_ENDPOINT 或 S3_INTERNAL/PUBLIC_ENDPOINT）必须同时配置',
      });
    }
    if (env.NODE_ENV === 'production') {
      if (s3Started && (coreSet.length !== S3_CORE_FIELDS.length || !hasAnyEndpoint)) {
        ctx.addIssue({
          code: 'custom',
          input: coreSet,
          message: '生产环境必须配置全部 S3_* 变量',
        });
      }
      if (s3Started && (!env.S3_INTERNAL_ENDPOINT || !env.S3_PUBLIC_ENDPOINT)) {
        ctx.addIssue({
          code: 'custom',
          input: env.S3_INTERNAL_ENDPOINT,
          message: '生产环境必须配置 S3_INTERNAL_ENDPOINT 与 S3_PUBLIC_ENDPOINT（浏览器 presigned URL 绝不能使用内网 endpoint）',
        });
      }
      if (!env.SESSION_SECRET || env.SESSION_SECRET.length < 32) {
        ctx.addIssue({
          code: 'custom',
          input: env.SESSION_SECRET,
          message: '生产环境 SESSION_SECRET 必填且至少 32 字符',
        });
      }
      if (!env.DEVICE_TOKEN_PEPPER || env.DEVICE_TOKEN_PEPPER.length < 32) {
        ctx.addIssue({
          code: 'custom',
          input: env.DEVICE_TOKEN_PEPPER,
          message: '生产环境 DEVICE_TOKEN_PEPPER 必填且至少 32 字符',
        });
      }
      if (!s3Started) {
        ctx.addIssue({
          code: 'custom',
          input: null,
          message: '生产环境必须配置 S3_* 变量（对象存储为核心功能）',
        });
      }
    }
  });

export type NodeEnv = 'development' | 'test' | 'production';

export interface S3Config {
  /** 服务端操作（HeadObject/CopyObject/Delete/bucket）使用的 endpoint：Sealos 内网地址 */
  internalEndpoint: string;
  /** 生成浏览器 presigned PUT/GET 的 endpoint：必须公网可解析，绝不能下发内网地址 */
  publicEndpoint: string;
  region: string;
  bucket: string;
  accessKey: string;
  secretKey: string;
}

export interface AppConfig {
  nodeEnv: NodeEnv;
  port: number;
  databaseUrl: string;
  s3: S3Config | null;
  sessionSecret: string | null;
  deviceTokenPepper: string | null;
  publicAppUrl: string | null;
  /** 生产静态托管目录（apps/web/dist）；未设置则不托管静态文件 */
  webDistDir: string | null;
  cloudCleanupEnabled: boolean;
}

export class EnvValidationError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(
      '环境变量校验失败：\n' + issues.map((i) => `  - ${i}`).join('\n'),
    );
    this.name = 'EnvValidationError';
    this.issues = issues;
  }
}

export function parseEnv(input: Record<string, string | undefined>): AppConfig {
  const parsed = envSchema.safeParse(input);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => {
      const key = issue.path.length > 0 ? issue.path.join('.') : '(root)';
      return `${key}: ${issue.message}`;
    });
    throw new EnvValidationError(issues);
  }
  const e = parsed.data;
  const internalEndpoint = e.S3_INTERNAL_ENDPOINT ?? e.S3_ENDPOINT ?? null;
  const publicEndpoint = e.S3_PUBLIC_ENDPOINT ?? e.S3_ENDPOINT ?? null;
  const s3 =
    e.S3_REGION && e.S3_BUCKET && e.S3_ACCESS_KEY && e.S3_SECRET_KEY && internalEndpoint && publicEndpoint
      ? {
          // 单 endpoint（本地 MinIO）：内外共用；生产：INTERNAL/PUBLIC 必填（校验强制）
          internalEndpoint,
          publicEndpoint,
          region: e.S3_REGION,
          bucket: e.S3_BUCKET,
          accessKey: e.S3_ACCESS_KEY,
          secretKey: e.S3_SECRET_KEY,
        }
      : null;
  return {
    nodeEnv: e.NODE_ENV,
    port: e.PORT,
    databaseUrl: e.DATABASE_URL,
    s3,
    sessionSecret: e.SESSION_SECRET ?? null,
    deviceTokenPepper: e.DEVICE_TOKEN_PEPPER ?? null,
    publicAppUrl: e.PUBLIC_APP_URL ?? null,
    webDistDir: e.WEB_DIST_DIR ?? null,
    cloudCleanupEnabled: e.CLOUD_CLEANUP_ENABLED,
  };
}

/** 从 cwd 逐级向上查找 .env（monorepo 子包运行时也能找到仓库根目录的 .env） */
export function findEnvFile(startDir: string = process.cwd()): string | null {
  let dir = path.resolve(startDir);
  for (;;) {
    const candidate = path.join(dir, '.env');
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** 加载 .env（若存在）并校验环境变量；校验失败抛 EnvValidationError */
export function loadEnv(): AppConfig {
  const envFile = findEnvFile();
  if (envFile) {
    dotenvConfig({ path: envFile, quiet: true });
  }
  return parseEnv(process.env as Record<string, string | undefined>);
}
