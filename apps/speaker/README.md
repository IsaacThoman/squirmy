# Squirmy speaker

A headless Squirmy Connect speaker: it appears in every Squirmy app's device list, and plays the
session on the sound card of a Raspberry Pi or any Linux computer. Install, pairing, picking the
output and bit-perfect playback: [docs/server/speaker.md](../../docs/server/speaker.md).

```sh
npm ci && npm run dev:speaker            # from the repository root
docker compose -f apps/speaker/compose.yaml up -d --build
```

The code: `engine.ts` (the `PlayerEngine`: a paced PCM timeline, gapless boundaries, pause, seek
and stalls), `decoder.ts` (ffmpeg, trimmed with the descriptor's gapless numbers), `sinks.ts`
(`aplay`, `pacat`), `speaker.ts` (`SessionClient` on the socket), `pairing.ts`, `status.ts` (the
LAN status page and mDNS) and `main.ts` (the command).
