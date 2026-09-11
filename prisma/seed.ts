/**
 * Seed 数据（PRD §23）：只在 development 运行。
 * 创建：Family「测试家庭」、Admin 成员「维」、相框设备「客厅相框」。
 * 使用明显测试密码；生产部署不会自动运行本脚本（生产用 prisma migrate deploy，不触发 seed）。
 * 运行：npm run db:seed
 */
import crypto from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { hashPin } from '../apps/api/src/auth/pin';
import { deviceTokenHash, generateDeviceToken } from '../apps/api/src/auth/deviceToken';

if (process.env.NODE_ENV === 'production') {
  console.error('禁止在生产环境运行 dev seed（PRD §23）');
  process.exit(1);
}

const prisma = new PrismaClient();

const FAMILY_CODE = 'TEST888';
const ADMIN_NAME = '维';
const ADMIN_PIN = '123456';
const DEVICE_NAME = '客厅相框';

async function main(): Promise<void> {
  let family = await prisma.family.findUnique({ where: { code: FAMILY_CODE } });
  if (!family) {
    family = await prisma.family.create({ data: { code: FAMILY_CODE, name: '测试家庭' } });
    console.log(`已创建家庭：测试家庭（邀请码 ${FAMILY_CODE}）`);
  } else {
    console.log(`家庭已存在：测试家庭（邀请码 ${FAMILY_CODE}）`);
  }

  const existingAdmin = await prisma.member.findFirst({
    where: { familyId: family.id, displayName: ADMIN_NAME },
  });
  if (!existingAdmin) {
    await prisma.member.create({
      data: {
        familyId: family.id,
        displayName: ADMIN_NAME,
        role: 'ADMIN',
        pinHash: await hashPin(ADMIN_PIN),
      },
    });
    console.log(`已创建管理员成员：${ADMIN_NAME}（PIN ${ADMIN_PIN}）`);
  } else {
    console.log(`管理员成员已存在：${ADMIN_NAME}`);
  }

  const existingDevice = await prisma.device.findFirst({
    where: { familyId: family.id, name: DEVICE_NAME },
  });
  if (existingDevice) {
    console.log(`设备已存在：${DEVICE_NAME}（token 不重复生成；如需新 token 请删除 devices 表中该行后重跑）`);
  } else {
    const pepper = process.env.DEVICE_TOKEN_PEPPER ?? crypto.randomBytes(32).toString('hex');
    if (!process.env.DEVICE_TOKEN_PEPPER) {
      console.warn('警告：DEVICE_TOKEN_PEPPER 未设置，本次使用随机盐（.env 配置后 token 才稳定）');
    }
    const token = generateDeviceToken();
    await prisma.device.create({
      data: {
        familyId: family.id,
        name: DEVICE_NAME,
        tokenHash: deviceTokenHash(token, pepper),
      },
    });
    console.log('已创建设备：客厅相框');
    console.log('===== 设备 token（仅此一次显示，供相框端 M3 使用）=====');
    console.log(token);
    console.log('================================================');
  }
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (err) => {
    console.error(err);
    await prisma.$disconnect();
    process.exit(1);
  });
