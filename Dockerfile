# syntax=docker/dockerfile:1.7
# ThreadMap: one image, three supervised Node processes (web, companion, worker).
ARG NODE_IMAGE=node:24-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205

FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

FROM ${NODE_IMAGE} AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

FROM ${NODE_IMAGE} AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM ${NODE_IMAGE} AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    APP_ROOT=/app \
    MIGRATIONS_DIR=/app/migrations \
    FIXTURE_DIR=/app/fixtures/v1
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates tini && rm -rf /var/lib/apt/lists/*
COPY --from=build /app/.next/standalone ./
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/dist ./dist
COPY --from=build /app/src/db/migrations ./migrations
COPY --from=build /app/fixtures/v1 ./fixtures/v1
COPY --from=build /app/package.json ./package.json
RUN mkdir -p /app/.data && chown -R node:node /app/.data
USER node
# Only the web port is exposed; companion and worker have no listening ports.
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s CMD node -e "fetch('http://127.0.0.1:3000/api/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/supervisor.js"]
