# syntax=docker/dockerfile:1

# One image: API, worker and the built web app. SQUIRMY_ROLE picks what a container runs.

FROM node:24-trixie-slim AS build
WORKDIR /app
# Native modules (argon2) compile here when no prebuilt binary matches the platform.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/mobile/package.json apps/mobile/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/client-core/package.json packages/client-core/package.json
# Only the server, the web app and the shared packages: the mobile app's dependencies
# are not needed to build the image. The root postinstall patches a mobile-only package,
# so scripts are skipped and the native modules are rebuilt explicitly.
RUN npm ci --ignore-scripts --include=dev --include-workspace-root \
      -w @squirmy/contracts -w @squirmy/client-core -w @squirmy/server -w @squirmy/web \
 && npm rebuild argon2 esbuild
COPY packages packages
COPY apps/server apps/server
COPY apps/web apps/web
RUN npm run build:packages \
 && npm run build -w @squirmy/server \
 && npm run build -w @squirmy/web

FROM node:24-trixie-slim AS dependencies
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/mobile/package.json apps/mobile/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/client-core/package.json packages/client-core/package.json
COPY scripts/prune-node-modules.mjs scripts/prune-node-modules.mjs
# npm also installs what other workspaces hoisted to the root; keep only what the server uses.
RUN npm ci --ignore-scripts --omit=dev -w @squirmy/server \
 && npm rebuild argon2 \
 && node scripts/prune-node-modules.mjs apps/server

FROM node:24-trixie-slim AS runtime
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg libchromaprint-tools tini \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /data /music && chown node:node /data
WORKDIR /app
# Release builds pass the version; without it the server reports "dev".
ARG SQUIRMY_VERSION=
ENV NODE_ENV=production \
    SQUIRMY_VERSION=${SQUIRMY_VERSION} \
    SQUIRMY_DATA_DIR=/data \
    SQUIRMY_WEB_DIST=/app/apps/web/dist \
    HOST=0.0.0.0 \
    PORT=4747
COPY --from=dependencies /app/node_modules node_modules
COPY --from=dependencies /app/package.json package.json
COPY --from=build /app/packages/contracts/package.json packages/contracts/package.json
COPY --from=build /app/packages/contracts/dist packages/contracts/dist
COPY --from=build /app/packages/client-core/package.json packages/client-core/package.json
COPY --from=build /app/packages/client-core/dist packages/client-core/dist
COPY --from=build /app/apps/server/package.json apps/server/package.json
COPY --from=build /app/apps/server/dist apps/server/dist
COPY --from=build /app/apps/server/drizzle apps/server/drizzle
COPY --from=build /app/apps/web/dist apps/web/dist
USER node
VOLUME /data
EXPOSE 4747
HEALTHCHECK --interval=15s --timeout=5s --start-period=40s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 4747) + '/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
ENTRYPOINT ["tini", "--"]
CMD ["node", "apps/server/dist/index.js"]
