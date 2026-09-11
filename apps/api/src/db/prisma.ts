import { PrismaClient } from '@prisma/client';

/**
 * PrismaClient 单例。
 * 开发模式下 tsx watch 重载模块时复用全局实例，避免连接堆积。
 */
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma: PrismaClient = globalForPrisma.prisma ?? new PrismaClient();

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}
