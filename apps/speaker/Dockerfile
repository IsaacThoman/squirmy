# syntax=docker/dockerfile:1
# The Squirmy speaker. Build from the repository root, on the Pi or for it:
#   docker build -f apps/speaker/Dockerfile -t squirmy-speaker .
#   docker buildx build --platform linux/arm64 -f apps/speaker/Dockerfile -t squirmy-speaker .
# Run it with the sound card and the host's network (for mDNS); see apps/speaker/compose.yaml
# and docs/server/speaker.md.

# Only JavaScript is built, so the build runs on the builder's own platform.
FROM --platform=$BUILDPLATFORM node:24-trixie-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/client-core/package.json packages/client-core/package.json
COPY apps/speaker/package.json apps/speaker/package.json
# Only the speaker and what it needs; the root postinstall patches a mobile-only package.
RUN npm ci --ignore-scripts --include=dev --include-workspace-root -w @squirmy/contracts -w @squirmy/client-core -w @squirmy/speaker
COPY packages/contracts packages/contracts
COPY packages/client-core packages/client-core
COPY apps/speaker apps/speaker
RUN npm run build -w @squirmy/contracts \
 && npm run build -w @squirmy/client-core \
 && npm run build -w @squirmy/speaker

# The speaker has no native modules, so its production dependencies install the same anywhere.
FROM --platform=$BUILDPLATFORM node:24-trixie-slim AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/client-core/package.json packages/client-core/package.json
COPY apps/speaker/package.json apps/speaker/package.json
RUN npm ci --ignore-scripts --omit=dev -w @squirmy/speaker

FROM node:24-trixie-slim
# ffmpeg decodes; aplay (ALSA) and pacat (PulseAudio and PipeWire) play; amixer turns a hardware volume.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg alsa-utils pulseaudio-utils tini \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /data && chown node:node /data
WORKDIR /app
ENV NODE_ENV=production SQUIRMY_SPEAKER_STATE_DIR=/data
COPY --from=dependencies /app/node_modules node_modules
COPY --from=build /app/package.json package.json
COPY --from=build /app/packages/contracts/package.json packages/contracts/package.json
COPY --from=build /app/packages/contracts/dist packages/contracts/dist
COPY --from=build /app/packages/client-core/package.json packages/client-core/package.json
COPY --from=build /app/packages/client-core/dist packages/client-core/dist
COPY --from=build /app/apps/speaker/package.json apps/speaker/package.json
COPY --from=build /app/apps/speaker/dist apps/speaker/dist
# The node user is in the audio group, which owns /dev/snd on Debian and Raspberry Pi OS.
RUN usermod -aG audio node
USER node
VOLUME /data
EXPOSE 4790
ENTRYPOINT ["tini", "--"]
CMD ["node", "apps/speaker/dist/main.js"]
