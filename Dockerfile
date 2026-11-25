# syntax=docker/dockerfile:1

FROM node:24-alpine AS builder
WORKDIR /app

ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1 \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

RUN npm install -g pnpm@12.23.0

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN pnpm install --frozen-lockfile --ignore-scripts

COPY server ./server
COPY tools/db-migrate.cjs tools/db-seed.cjs ./tools/

RUN pnpm run build \
  && pnpm prune --prod

FROM node:24-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production \
    PORT=7741 \
    ORANGE_BIND=0.0.0.0 \
    ORANGE_DATA_DIR=/app/data \
    LOG_FORMAT=json \
    LOG_LEVEL=info

COPY --from=builder --chown=node:node /app/package.json ./package.json
COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/dist ./dist
COPY --chown=node:node web ./web
COPY --chown=node:node tools/db-migrate.cjs tools/db-seed.cjs ./tools/

RUN mkdir -p /app/data && chown -R node:node /app/data

USER node

EXPOSE 7741

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||7741)+'/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/server/index.js"]
