# 家庭语音相框生产镜像（PRD M5 §八）
# 一个容器同时提供 /api/* 与 Web 构建产物；数据库迁移通过
#   docker exec <容器> npx prisma migrate deploy
# 或平台一次性任务执行，容器启动本身不运行 migrate / seed。
# 注意：不使用 # syntax= 指令（部分网络环境无法拉取 dockerfile frontend 镜像）。

# 网络受限环境可用 --build-arg 切换镜像源（Sealos/海外构建用默认值即可）：
#   --build-arg NPM_REGISTRY=https://registry.npmmirror.com
#   --build-arg PRISMA_ENGINES_MIRROR=https://registry.npmmirror.com/-/binary/prisma
ARG NPM_REGISTRY=https://registry.npmjs.org
ARG PRISMA_ENGINES_MIRROR=https://binaries.prisma.sh

########## 阶段 1：构建 monorepo（Web + API + Prisma client）##########
FROM node:22-alpine AS build
ARG NPM_REGISTRY
ARG PRISMA_ENGINES_MIRROR
ENV PRISMA_ENGINES_MIRROR=${PRISMA_ENGINES_MIRROR}
WORKDIR /app

# 先拷贝依赖清单与 prisma schema（postinstall 需要），利用层缓存
COPY package.json package-lock.json ./
COPY prisma ./prisma
COPY apps/web/package.json apps/web/
COPY apps/api/package.json apps/api/
COPY packages/shared/package.json packages/shared/
RUN npm ci --registry=${NPM_REGISTRY}

COPY . .
# 生成 API dist（esbuild）与 Web dist（vite）
RUN npm run build

########## 阶段 2：生产运行时 ##########
FROM node:22-alpine AS runtime
ARG NPM_REGISTRY
ARG PRISMA_ENGINES_MIRROR
ENV PRISMA_ENGINES_MIRROR=${PRISMA_ENGINES_MIRROR}
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    WEB_DIST_DIR=/app/apps/web/dist

# prisma 已移入 dependencies：运行时镜像可执行 `npx prisma migrate deploy`
# --workspace 过滤：只安装 api/shared/root 的生产依赖，web 的 react 等不进入 runtime
# 所有 COPY 直接以 node 属主落盘，无需 chown -R（避免整目录复制导致镜像体积翻倍）
COPY --chown=node:node package.json package-lock.json ./
COPY --chown=node:node prisma ./prisma
COPY --chown=node:node apps/web/package.json apps/web/package.json
COPY --chown=node:node apps/api/package.json apps/api/package.json
COPY --chown=node:node packages/shared/package.json packages/shared/package.json
COPY --chown=node:node --from=build /app/apps/api/dist ./apps/api/dist
COPY --chown=node:node apps/api/scripts ./apps/api/scripts
COPY --chown=node:node --from=build /app/apps/web/dist ./apps/web/dist
RUN npm ci --omit=dev \
      --workspace @family-frame/api \
      --workspace @family-frame/shared \
      --include-workspace-root \
      --registry=${NPM_REGISTRY} \
 && npm cache clean --force \
 && npx prisma generate --schema=prisma/schema.prisma \
 && rm -f /app/prisma/seed.ts

# 非 root 用户运行（文件已属 node，无需 chown 层）
USER node

EXPOSE 3000

# 应用内正确处理 SIGTERM（server.close + 兜底退出），适配容器编排停止信号
CMD ["node", "apps/api/dist/index.js"]
