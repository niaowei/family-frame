import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { S3Config } from '../config/env';

/**
 * S3 服务封装（PRD §10 / M5 双 endpoint）：
 * - serverClient：S3_INTERNAL_ENDPOINT —— 服务端操作（HeadObject/CopyObject/Delete/Range 读），
 *   应用与对象存储同在 Sealos 内网时优先走内网；
 * - presignClient：S3_PUBLIC_ENDPOINT —— 生成浏览器实际访问的 presigned PUT/GET。
 *   浏览器绝不能收到只能在内网解析的 endpoint 地址。
 * - S3 secret 永不下发浏览器；presigned URL 仅含短期签名参数。
 * - forcePathStyle：MinIO 与 Sealos 等 S3 兼容实现均使用路径风格。
 */
export class S3Service {
  readonly bucket: string;
  private readonly serverClient: S3Client;
  private readonly presignClient: S3Client;

  constructor(config: S3Config) {
    this.bucket = config.bucket;
    const base = {
      region: config.region,
      credentials: {
        accessKeyId: config.accessKey,
        secretAccessKey: config.secretKey,
      },
      forcePathStyle: true,
    };
    this.serverClient = new S3Client({ ...base, endpoint: config.internalEndpoint });
    this.presignClient = new S3Client({ ...base, endpoint: config.publicEndpoint });
  }

  /** 生成浏览器可访问的公网 presigned URL（写入方向） */
  async presignPut(key: string, mimeType: string, expiresInSec: number): Promise<string> {
    const command = new PutObjectCommand({ Bucket: this.bucket, Key: key, ContentType: mimeType });
    return getSignedUrl(this.presignClient, command, { expiresIn: expiresInSec });
  }

  /** 生成浏览器可访问的公网 presigned URL（读取方向） */
  async presignGet(key: string, expiresInSec: number): Promise<string> {
    const command = new GetObjectCommand({ Bucket: this.bucket, Key: key });
    return getSignedUrl(this.presignClient, command, { expiresIn: expiresInSec });
  }

  async headObject(key: string): Promise<{ size: number; contentType: string | undefined } | null> {
    try {
      const out = await this.serverClient.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return { size: out.ContentLength ?? 0, contentType: out.ContentType };
    } catch (err) {
      if (err instanceof Error && err.name === 'NotFound') return null;
      // S3 的 HeadObject 404 也可能以 404 状态包装
      const anyErr = err as { $metadata?: { httpStatusCode?: number }; name?: string };
      if (anyErr?.$metadata?.httpStatusCode === 404 || anyErr?.name === 'NoSuchKey') return null;
      throw err;
    }
  }

  /** 读取对象前 n 个字节（用于魔数嗅探）——服务端操作，走内网 */
  async getHeadBytes(key: string, n: number): Promise<Buffer> {
    const out = await this.serverClient.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key, Range: `bytes=0-${n - 1}` }),
    );
    const bytes = await out.Body?.transformToByteArray();
    return Buffer.from(bytes ?? []);
  }

  async copyObject(fromKey: string, toKey: string): Promise<void> {
    await this.serverClient.send(
      new CopyObjectCommand({
        Bucket: this.bucket,
        Key: toKey,
        CopySource: `/${this.bucket}/${fromKey}`,
      }),
    );
  }

  async deleteObject(key: string): Promise<void> {
    await this.serverClient.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
}

export function createS3(config: S3Config | null): S3Service | null {
  return config ? new S3Service(config) : null;
}
