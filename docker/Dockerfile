# Build context: repository root.  docker compose -f docker/docker-compose.yml up -d --build
FROM node:24-alpine
WORKDIR /app
RUN corepack enable && apk add --no-cache ffmpeg
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/shared/package.json packages/shared/
COPY apps/server/package.json apps/server/
RUN pnpm install --frozen-lockfile --prod --filter @kazetix/server...
COPY packages/shared/src packages/shared/src
COPY apps/server/src apps/server/src
RUN mkdir -p /data && chown node:node /data
ENV NODE_ENV=production DATA_DIR=/data PORT=8767
USER node
EXPOSE 8767
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:8767/healthz || exit 1
CMD ["node", "apps/server/src/main.ts"]
