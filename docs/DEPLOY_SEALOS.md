# Sealos 生产部署指南（M5）

> 目标：让「家里来照片了」脱离开发者电脑，在 Sealos 上长期独立运行。
> 本文档对应版本 `0.1.0`。所有 `<尖括号>` 为需要替换的真实值；**不要把任何真实 secret 写进本文档或 Git**。

## 架构

```text
一个公网 HTTPS Origin（Sealos 自动域名）
        │
        ▼
Family Frame App（单容器：Express /api/* + Web 静态产物 + SPA fallback）
        │ Sealos 内网
        ├── MySQL 8（不暴露公网）
        └── Object Storage（private bucket）
```

单实例（1 replica）原则：家庭规模极小；限流为进程内存实现；扩到多副本前需先评估共享限流。

---

## 1. 创建 MySQL

1. Sealos 控制台 → 数据库 → 创建 MySQL 8；
2. 记录**内网连接地址**（形如 `mysql://<user>:<pass><internal-host>:3306/<db>`）；
3. 确认不勾选公网暴露；
4. 确认备份设置：开启自动/计划备份，记录频率与保留策略（平台默认即可，写入下文 §15 备份小节）。

## 2. 创建 private Object Storage

1. Sealos 控制台 → 对象存储 → 创建 bucket（如 `family-frame`）；
2. **保持 private**（禁止 publicRead / publicReadWrite）；
3. 记录 Access Key / Secret Key；
4. 记录两个 endpoint：
   - **Internal Endpoint**（`*.internal`，应用服务端操作用）；
   - **Public Endpoint**（公网，生成浏览器 presigned URL 用）；
5. 在 bucket 的 CORS 设置中添加规则（若无则平台默认放行，需实测）：
   - Origin：`https://<你的 Sealos App 域名>`（尽量不用 `*`）；
   - Methods：`PUT, GET, HEAD`；
   - Headers：`Content-Type`（如可再加 `*`）。

## 3. 生产环境变量清单

在 Sealos App Deploy 的环境变量中设置（不要写进代码/文档/Git）：

```text
NODE_ENV=production
PORT=3000
DATABASE_URL=<Sealos MySQL 内网连接串>
S3_INTERNAL_ENDPOINT=<内网 endpoint>
S3_PUBLIC_ENDPOINT=<公网 endpoint>
S3_REGION=<region，通常 us-east-1>
S3_BUCKET=<bucket 名>
S3_ACCESS_KEY=<AK>
S3_SECRET_KEY=<SK>
SESSION_SECRET=<openssl rand -hex 32 生成>
DEVICE_TOKEN_PEPPER=<openssl rand -hex 32 生成>
PUBLIC_APP_URL=https://<你的 Sealos App 域名>
WEB_DIST_DIR=/app/apps/web/dist
```

校验逻辑（启动时强制）：生产缺 SESSION_SECRET / DEVICE_TOKEN_PEPPER（≥32 字符）、缺 S3_* 或缺双 endpoint 会**拒绝启动**。

## 4. Docker 镜像

```bash
docker build -t <你的镜像仓库>/family-frame:0.1.0 .
docker push <你的镜像仓库>/family-frame:0.1.0
```

镜像为 multi-stage：build 阶段构建 monorepo；runtime 仅含 production 依赖、API dist、Web dist、prisma schema/migrations、bootstrap 脚本；非 root 用户；响应 SIGTERM；暴露 3000。
runtime 通过 `--workspace @family-frame/api --workspace @family-frame/shared` 过滤安装（web 的 react 等不进入 runtime）；COPY 全部带 `--chown=node:node`，避免 chown -R 产生整目录复制层。
国内网络拉取基础镜像失败时：先 `docker pull docker.m.daocloud.io/library/node:22-alpine` 再 `docker tag` 为 `node:22-alpine`；构建时 npm/prisma 源可用 `--build-arg NPM_REGISTRY=https://registry.npmmirror.com --build-arg PRISMA_ENGINES_MIRROR=https://registry.npmmirror.com/-/binary/prisma`。

## 4a. Publish Container Image（发布到 Registry）

本地 `docker build` 成功 ≠ Sealos 能取到镜像——必须推送到一个 Sealos 可拉取的 OCI Registry。

**镜像 tag 规范**：

```text
<registry-host>/<namespace>/family-frame:<语义化版本>
```

按所选 Registry 三选一（`<namespace>` 分别为 Docker Hub 用户名 / GitHub 用户名 / 阿里云命名空间）：

| Registry | image reference 示例 |
|---|---|
| Docker Hub | `docker.io/<username>/family-frame:0.1.0` |
| GHCR | `ghcr.io/<username>/family-frame:0.1.0` |
| 阿里云 ACR（国内推荐） | `registry.cn-hangzhou.aliyuncs.com/<namespace>/family-frame:0.1.0` |

**login / tag / push / pull 验证**（以 Docker Hub 为例，其他 Registry 仅替换 host）：

```bash
# 1. 登录（输入用户名密码或 Access Token；凭据由 docker login 保存在本机，禁止写入任何文件）
docker login docker.io

# 2. 为本地已验证镜像打 tag
docker tag family-frame:0.1.0 docker.io/<username>/family-frame:0.1.0

# 3. 推送
docker push docker.io/<username>/family-frame:0.1.0

# 4. pull 验证：先删除本地 tag 与镜像，确保拉回的是 Registry 上的产物
docker rmi docker.io/<username>/family-frame:0.1.0 family-frame:0.1.0
docker pull docker.io/<username>/family-frame:0.1.0

# 5. 用拉回的镜像跑一次冒烟（不带任何业务环境变量，能启动并拒绝缺配置即证明镜像完整）
docker run --rm -p 8080:3000 docker.io/<username>/family-frame:0.1.0
# 预期日志：环境变量校验失败（生产强制项）——这本身证明新镜像可运行、校验生效
```

**Sealos App Deploy 填写**：镜像名直接填完整 reference（如 `docker.io/<username>/family-frame:0.1.0`）。

**私有 Registry 的拉取凭据**：若镜像仓库为 private，在 Sealos 控制台「镜像仓库/Secret」中创建 `kubernetes.io/dockerconfigjson` 类型 Secret（填写 Registry 地址、用户名、密码），并在应用部署时选择该 Secret 作为 imagePullSecret；或使用 Sealos「我的仓库」功能绑定凭据后从界面选择镜像。

**版本发布 0.1.0 → 0.1.1**：

```bash
docker build -t <registry>/<namespace>/family-frame:0.1.1 .
docker push <registry>/<namespace>/family-frame:0.1.1
# Sealos App Deploy 更新镜像 tag → 滚动重启 → docker exec migrate deploy → /health 校验版本号
```

**回滚到 0.1.0**：App Deploy 把镜像 tag 改回 `...family-frame:0.1.0` 保存即可（0.1.0 仍保留在 Registry）。

> ⚠️ 本文撰写时本地环境无任何 Registry 凭据，**尚未真实 push**——以上命令待人工登录后执行并按第 3-5 步验收。

## 5. Sealos App Deploy

1. Sealos 控制台 → 应用管理 → 创建应用；
2. 镜像：`<你的镜像仓库>/family-frame:0.1.0`；
3. 端口：3000（开启公网访问，记录自动生成的 HTTPS 域名）；
4. 环境变量：§3 清单；
5. 副本数：**1**（单实例原则）；
6. 资源：0.5C / 1Gi 起步即可；
7. 部署并确认 Pod Running。

## 6. 数据库迁移（一次性 / 每次发版）

```bash
docker exec <容器名> npx prisma migrate deploy --schema=prisma/schema.prisma
```

或平台"终端"功能执行同一命令。**禁止** `prisma migrate dev`、禁止 dev seed。
验证：`SHOW TABLES` 应有 families / members / devices / posts / media / device_reads / _prisma_migrations。

## 7. 初始化家庭（bootstrap，一次性）

```bash
docker exec -it \
  -e FAMILY_NAME=<家庭名> \
  -e FAMILY_CODE=<邀请码> \
  -e FAMILY_ADMIN_NAME=<管理员名> \
  -e FAMILY_ADMIN_PIN=<4-20位数字> \
  <容器名> node apps/api/scripts/bootstrap-family.mjs
```

- 无环境变量时进入交互模式（PIN 为 masked input）；
- 邀请码已存在 → 明确拒绝（不覆盖）；
- **device token 仅此一次打印**：立即保存到密码管理器；丢失只能重新配对（重跑 bootstrap 会拒绝重复邀请码，设备需手工在数据库层面处理或联系开发者）；
- PIN 明文与 token 均不落库/不进日志；
- 环境变量方式用完即弃，禁止写入任何文件。

## 8. 验证

```bash
curl https://<你的域名>/health
# → {"status":"ok","app":"家里来照片了","version":"0.1.0",...}
```

浏览器打开 `https://<你的域名>/login` → 邀请码 + 管理员名 + PIN 登录 → /send 上传 → /history 查看。

## 9. 手机上传验证（家人端）

用手机浏览器完成一次端到端验证：邀请码登录 → `/send` 上传一张照片和一段语音 → `/history` 确认可见 → 相框端同步收到并能播放。

## 10. 相框（Frame）配对

1. 相框设备打开 `https://<你的域名>/frame`；
2. 首次显示配置界面 → 粘贴 §7 保存的 device token → 保存；
3. 照片出现即配对成功（token 存于相框浏览器 localStorage，之后免配置）。

## 11. 更新版本

```bash
docker build -t <镜像仓库>/family-frame:0.1.1 .
docker push <镜像仓库>/family-frame:0.1.1
# Sealos App Deploy 更新镜像 tag → 滚动重启
docker exec <新容器> npx prisma migrate deploy --schema=prisma/schema.prisma
```

- SW 不强制刷新：旧页面继续运行，自然重开后使用新版本；
- migration 只增不破坏（开发期禁止破坏性 reset）。

## 12. 回滚

- 保留上一个成功 image tag（如 0.1.0），App Deploy 把镜像改回即可；
- 数据库不做破坏性回滚（migrations 只前进）；
- 回滚后 /health 确认版本号回到旧值。

## 13. 数据库备份

- 平台自动备份：在 Sealos MySQL 控制台确认并记录频率/保留策略；
- 手动导出：

```bash
docker exec <mysql容器> mysqldump -u<user> -p<pass> <db> > backup-$(date +%F).sql
# 或 Sealos 控制台的备份/下载功能
```

- 已在本地验证 `mysqldump` 可导出非空备份（10.5KB，含全部表 INSERT）；
- 恢复：`mysql -u<user> -p<pass> <db> < backup-xxx.sql`。

## 14. 常见故障

| 症状 | 排查 |
|---|---|
| 容器启动即退出，日志见"环境变量校验失败" | 按日志逐条补齐环境变量（生产强制项见 §3） |
| /health ok 但上传 503 storage | S3_* 未配或 INTERNAL endpoint 错误 |
| 手机 presign 后 PUT 一直失败 | S3_PUBLIC_ENDPOINT 用了内网地址；或 bucket CORS 未放行生产 Origin |
| 登录后刷新掉线 | PUBLIC_APP_URL/域名 与实际访问不一致；确认 HTTPS（Secure cookie 需 HTTPS） |
| 相框配置 token 后无照片 | token 与 DEVICE_TOKEN_PEPPER 不匹配（换了 pepper 必须重新配对）；或 bootstrap 未执行 |
| 迁移报 P1001 | DATABASE_URL 内网地址/密码错误，或 MySQL 未在同集群 |
