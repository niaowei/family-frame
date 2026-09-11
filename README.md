# 家里来照片了 — 家庭语音相框

> 家人用手机发送照片、一句话或一段语音，长辈在客厅的相框上就能看到照片、听到你的声音。

这是一个完整的家庭相框解决方案：手机浏览器即开即用的发送端、部署在云上的 API 服务、以及跑在 Android 相框设备上的原生客户端。专为长辈设计——相框端全屏自动轮播、无复杂交互，点亮屏幕即同步。

## 功能

**家人端（网页，手机可用）**

- 上传照片、写文字留言、录制语音
- 按家庭组织成员与内容，历史消息管理

**相框端（Android 原生）**

- 全屏轮播展示，新内容到达不突兀打断当前展示
- 回到主界面立即同步；停留主屏时定时轮询
- 真人录音本地播放；纯文字留言用微软在线神经语音（zh-CN-XiaoxiaoNeural）播报，网络不可用时自动回落 eSpeakNG 离线合成
- 设备令牌配对（家人端生成短码，相框输入兑换，令牌仅存哈希）
- 设置页：手动同步、剩余空间显示、照片/录音导出到储存卡与恢复
- 音量自适应、常亮、沉浸式全屏，适合长辈使用

**服务端**

- Express + Prisma + MySQL，设备令牌仅存 sha256(pepper:token)
- 媒体落盘完成回执（`POST /posts/:id/complete`）与 firstSeen/heard 事件上报
- 私有 S3 兼容对象存储；媒体经短期预签名 URL 分发
- 可选云端清理（`CLOUD_CLEANUP_ENABLED`，默认关闭）
- `/health`、`/health/db` 健康检查

## 技术栈

| 层 | 技术 |
|---|---|
| Web（家人端） | Vite + React 19 + TypeScript |
| API | Node.js 20+ / Express 5 + TypeScript |
| ORM / 数据库 | Prisma + MySQL 8 |
| 对象存储 | 本地开发 MinIO（S3 兼容）；生产任意 S3 兼容存储 |
| 相框端 | Android 原生（Java，minSdk 26 / targetSdk 35） |

## 目录结构

```text
├─ apps/
│  ├─ api/        # Express API（auth / uploads / posts / frame / family / pair / health）
│  ├─ web/        # Vite + React 家人端（/login、/send、/history、家庭管理）
│  └─ android/    # 相框原生端（FrameActivity / SyncEngine / VoiceEngine / Backup …）
├─ packages/
│  └─ shared/     # 前后端共享类型与常量
├─ prisma/        # schema + migrations + seed
├─ scripts/       # 设备验收脚本
├─ docs/          # Sealos 部署指南
└─ docker-compose.yml   # 本地开发：MySQL 8 + MinIO
```

## 本地开发

前置要求：Node.js ≥ 20.19、Docker。

```bash
# 1. 安装依赖（postinstall 自动执行 prisma generate）
npm install

# 2. 准备环境变量
cp .env.example .env
# 本地默认连 docker compose 的 MySQL 与 MinIO，无需修改即可开发

# 3. 启动 MySQL 8 + MinIO
docker compose up -d

# 4. 数据库 migration + 对象存储建桶 + seed 测试数据
npm run db:migrate
npm run s3:init
npm run db:seed
# seed 会输出测试家庭邀请码与管理员 PIN，并一次性打印相框设备 token

# 5. 启动 API（3000）与 Web（5173）
npm run dev
```

其他常用命令：`npm run test`（Vitest）、`npm run lint`、`npm run typecheck`、`npm run build`。

## 相框端（Android）

构建要求：JDK 17 与 Android SDK（详见 [apps/android/README.md](apps/android/README.md)）。

```bash
cd apps/android
./gradlew assembleDebug        # Windows: gradlew.bat assembleDebug
```

产物在 `app/build/outputs/apk/debug/app-debug.apk`。安装后进入设置页，填入服务端地址与设备令牌（由 `npm run bootstrap:family` 创建设备时一次性打印）即可完成绑定。

## 设备验收脚本

`scripts/check-frame-sync.mjs` 通过 ADB 对真机做端到端验收：校验服务端 feed、本地索引与媒体文件、完成回执、反复切换设置页与重启应用后内容不丢失。凭证仅在内存中读取，不会打印或落盘。

```bash
FRAME_ADB=<adb 路径> FRAME_BASE_URL=<服务端地址> node scripts/check-frame-sync.mjs <设备序列号>
```

## 生产部署

[docs/DEPLOY_SEALOS.md](docs/DEPLOY_SEALOS.md) 以 Sealos 为例记录了生产部署流程：托管 MySQL、私有对象存储桶、环境变量清单与镜像发布。任何能提供 MySQL 8 与 S3 兼容存储的平台均可参照。

## 许可证

[PolyForm Noncommercial 1.0.0](LICENSE) — 本项目**仅限非商业用途**（个人使用、家庭使用、学习研究等）。如需商业授权请联系作者。

Required Notice: Copyright (c) 2026 家里来照片了 contributors
