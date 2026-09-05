# BOOX Leaf5+ Dashboard 服务端
# 基础镜像 node:22-alpine,非 root 运行,带 /healthz 健康检查
FROM node:22-alpine

# alpine 默认无任何字体,装 font-noto 提供西文字体;
# 无中文字体时渲染器会自动回退英文文案(见 src/renderer.js 注释)
RUN apk add --no-cache font-noto

WORKDIR /app

# 先装依赖,利用 Docker 层缓存
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src

# 官方镜像自带 uid=1000 的 node 用户,非 root 运行
USER node

ENV PORT=39871
EXPOSE 39871

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/healthz" || exit 1

CMD ["node", "src/index.js"]
