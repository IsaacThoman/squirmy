# syntax=docker/dockerfile:1
# The cold-storage provider. Build from the repository root:
#   docker build -f adapters/cold-storage/Dockerfile -t squirmy-cold-storage .

FROM node:24-trixie-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/contracts packages/contracts
COPY adapters/kit adapters/kit
COPY adapters/cold-storage adapters/cold-storage
# Only this adapter and what it needs; the root postinstall patches a mobile-only package.
RUN npm ci --ignore-scripts --include-workspace-root -w @squirmy/contracts -w @squirmy/provider-kit -w @squirmy/adapter-cold-storage \
 && npm run build -w @squirmy/contracts \
 && npm run build -w @squirmy/provider-kit \
 && npm run build -w @squirmy/adapter-cold-storage \
 && npm prune --omit=dev --ignore-scripts -w @squirmy/adapter-cold-storage

FROM node:24-trixie-slim
WORKDIR /app
ENV NODE_ENV=production PORT=4800
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/package.json package.json
COPY --from=build /app/packages/contracts/package.json packages/contracts/package.json
COPY --from=build /app/packages/contracts/dist packages/contracts/dist
COPY --from=build /app/adapters/kit/package.json adapters/kit/package.json
COPY --from=build /app/adapters/kit/dist adapters/kit/dist
COPY --from=build /app/adapters/cold-storage/package.json adapters/cold-storage/package.json
COPY --from=build /app/adapters/cold-storage/dist adapters/cold-storage/dist
USER node
EXPOSE 4800
CMD ["node", "adapters/cold-storage/dist/main.js"]
