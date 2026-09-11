#!/usr/bin/env node
/**
 * 生产安全的一次性 bootstrap CLI（PRD M5 §三）。
 *
 * 用途：在真实数据库创建 家庭 + 第一个 ADMIN + 第一台相框设备。
 * - dev seed 在 production 被禁止；本工具专门为生产初始化设计；
 * - family code 已存在时明确拒绝（不默默覆盖）；
 * - PIN 使用 scrypt 哈希入库，明文不落库、不进日志；
 * - device token 只打印一次，数据库只存 sha256(pepper:token) hash，丢失只能重新生成；
 * - PIN 通过 masked input 交互输入，或通过环境变量 FAMILY_ADMIN_PIN 提供（避免写死源码）。
 *
 * 运行：npm run bootstrap:family
 */
import crypto from 'node:crypto';
import readline from 'node:readline';
import { PrismaClient } from '@prisma/client';

const isProduction = process.env.NODE_ENV === 'production';

function scryptAsync(password, salt, keylen, options) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, keylen, options, (err, derived) => {
      if (err) reject(err);
      else resolve(derived);
    });
  });
}

async function hashPin(pin) {
  const salt = crypto.randomBytes(16);
  const hash = await scryptAsync(pin, salt, 64, { N: 16384, r: 8, p: 1 });
  return ['scrypt', 16384, 8, 1, salt.toString('base64'), hash.toString('base64')].join('$');
}

function generateDeviceToken() {
  return crypto.randomBytes(24).toString('hex');
}

function deviceTokenHash(token, pepper) {
  return crypto.createHash('sha256').update(`${pepper}:${token}`).digest('hex');
}

/** masked input：逐字符读取，回显 * */
function askMasked(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    process.stdout.write(question);
    let value = '';
    const wasRaw = process.stdin.isRaw;
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    const onData = (ch) => {
      const c = ch.toString('utf8');
      if (c === '\r' || c === '\n') {
        process.stdin.removeListener('data', onData);
        if (process.stdin.isTTY) process.stdin.setRawMode(wasRaw ?? false);
        process.stdout.write('\n');
        rl.close();
        resolve(value);
      } else if (c === '\u0003') {
        process.exit(1); // Ctrl+C
      } else if (c === '\u007f' || c === '\b') {
        value = value.slice(0, -1);
        process.stdout.write('\b \b');
      } else if (c >= ' ' && c <= '~') {
        value += c;
        process.stdout.write('*');
      }
    };
    process.stdin.on('data', onData);
  });
}

function ask(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL 未设置：请在环境变量中提供生产数据库连接串');
    process.exit(1);
  }
  const pepper = process.env.DEVICE_TOKEN_PEPPER;
  if (!pepper || pepper.length < 32) {
    console.error('DEVICE_TOKEN_PEPPER 未设置或长度不足 32：设备 token hash 依赖它，且必须与部署环境一致');
    process.exit(1);
  }

  // 非交互模式：四个环境变量齐全时跳过提示（自动化/平台一次性任务用；
  // 环境变量仅临时提供，禁止写入文件或提交仓库）
  const envFamily = process.env.FAMILY_NAME?.trim();
  const envCode = process.env.FAMILY_CODE?.trim();
  const envAdmin = process.env.FAMILY_ADMIN_NAME?.trim();
  const envPin = process.env.FAMILY_ADMIN_PIN ?? '';
  const nonInteractive = !!(envFamily && envCode && envAdmin && envPin);

  console.log(`家庭初始化（环境：${isProduction ? 'production' : process.env.NODE_ENV || 'development'}）`);
  let familyName;
  let familyCode;
  let adminName;
  let pin;
  if (nonInteractive) {
    familyName = envFamily;
    familyCode = envCode;
    adminName = envAdmin;
    pin = envPin;
    console.log('使用环境变量提供的配置（PIN 内容不回显）');
  } else {
    familyName = await ask('家庭名称（例如：张家）: ');
    if (!familyName) {
      console.error('家庭名称不能为空');
      process.exit(1);
    }
    familyCode = (await ask('家庭邀请码（家人登录用，建议 6-12 位易读字符）: ')).trim();
    adminName = (await ask('管理员显示名（例如：维）: ')).trim();
    if (envPin) {
      pin = envPin;
      console.log('PIN：来自环境变量 FAMILY_ADMIN_PIN（不回显内容）');
    } else {
      pin = await askMasked('管理员 PIN（输入时不回显，4-20 位）: ');
    }
  }
  if (!adminName || adminName.length > 40) {
    console.error('管理员显示名不能为空且不超过 40 字符');
    process.exit(1);
  }
  if (!/^[A-Za-z0-9-]{4,32}$/.test(familyCode)) {
    console.error('邀请码格式无效：4-32 位字母/数字/连字符');
    process.exit(1);
  }
  if (!/^[0-9]{4,20}$/.test(pin)) {
    console.error('PIN 必须为 4-20 位数字');
    process.exit(1);
  }

  const prisma = new PrismaClient();
  try {
    const existingFamily = await prisma.family.findUnique({ where: { code: familyCode } });
    if (existingFamily) {
      // 明确拒绝，绝不默默覆盖
      console.error(`拒绝：邀请码 ${familyCode} 已存在（家庭「${existingFamily.name}」）。如需新增成员/设备请另选邀请码或手工操作。`);
      process.exit(1);
    }
    const dupMember = await prisma.member.findFirst({
      where: { displayName: adminName, family: { name: familyName } },
    });
    if (dupMember) {
      console.error('拒绝：同名成员已存在于同名家庭（异常状态），请检查数据库');
      process.exit(1);
    }

    const family = await prisma.family.create({ data: { code: familyCode, name: familyName } });
    await prisma.member.create({
      data: {
        familyId: family.id,
        displayName: adminName,
        role: 'ADMIN',
        pinHash: await hashPin(pin),
      },
    });

    const token = generateDeviceToken();
    await prisma.device.create({
      data: { familyId: family.id, name: '客厅相框', tokenHash: deviceTokenHash(token, pepper) },
    });

    console.log('\n========== 初始化完成 ==========');
    console.log(`家庭：${familyName}（邀请码 ${familyCode}）`);
    console.log(`管理员：${adminName}（PIN 已以 scrypt 哈希入库，明文未保存）`);
    console.log('设备：客厅相框');
    console.log('设备 token（仅此一次显示，请立即保存到相框设备配置；数据库只保存 hash）：');
    console.log(token);
    console.log('================================');
    console.log('提示：本输出包含 device token，请勿截图/粘贴到聊天或文档。');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error('初始化失败：', err instanceof Error ? err.message : err);
  process.exit(1);
});
