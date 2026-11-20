# Cold storage provider

An acquisition provider for music you already own but keep off the server's library: an archive disk, a slow NAS, a bucket mounted as a folder. Squirmy shows those tracks as playable on demand; playing one copies the file into the library through the normal import, and playback starts when it arrives.

It indexes the tags of every audio file under one folder and answers the server's [provider protocol](../../docs/provider-protocol.md):

- **Coverage** is `must_resolve`: a track lights up only after this provider confirmed it has the file.
- **Matching**, most specific first: the MusicBrainz recording id in the tags, then an ISRC, then artist and title (ignoring case, accents and punctuation; "Artist feat. Other" matches "Artist") with a length within 3 seconds. Without a requested length, the album title must match too, or the match must be the only one. Albums match by MusicBrainz release group id, else by album artist and title.
- **Delivery** uploads the file as it is, streamed from disk, with its folder name so an album stays together. Nothing is converted, and nothing comes from anywhere but the folder.

Files are read again only when their size or modification time changes, so rescans are cheap.

## Configuration

| Variable | Default | |
|---|---|---|
| `COLD_STORAGE_DIR` | | Folder of audio files. Required. Read only. |
| `COLD_STORAGE_SECRET` | | Shared secret, at least 8 characters. Required; enter the same one in Squirmy. |
| `COLD_STORAGE_NAME` | `Cold storage` | Shown on Squirmy's admin page. |
| `COLD_STORAGE_RESCAN_MINUTES` | `60` | How often to look for new files; `0` never. |
| `COLD_STORAGE_MAX_CONCURRENT` | `2` | Deliveries at once. |
| `PORT` | `4800` | |
| `HOST` | `0.0.0.0` | |

## With Docker Compose

Add a service next to Squirmy in your `compose.yaml` (the image is built from this repository):

```yaml
services:
  cold-storage:
    build:
      context: .
      dockerfile: adapters/cold-storage/Dockerfile
    restart: unless-stopped
    environment:
      COLD_STORAGE_DIR: /archive
      COLD_STORAGE_SECRET: ${COLD_STORAGE_SECRET:?set a secret}
    volumes:
      - /mnt/archive/music:/archive:ro
```

Then, in Squirmy:

1. Add the provider: base URL `http://cold-storage:4800` and the same secret (`POST /api/v1/admin/acquisition/providers` with `{ "name", "baseUrl", "secret" }`). The answer should show coverage `must_resolve` and no `lastError`.
2. Set the delivery address the provider uses to reach Squirmy on the Compose network: `PATCH /api/v1/admin/acquisition/policy` with `{ "deliveryBaseUrl": "http://app:4747" }` (the service name of Squirmy's container). Without it the server hands out `PUBLIC_URL`, which may not be reachable from inside the network.
3. Give the users who may fetch the "can acquire" flag. Admins always can.

Squirmy needs a managed library root to file the music into.

## Without Docker

```sh
npm ci
npm run build:packages && npm run build:adapters
COLD_STORAGE_DIR=/mnt/archive/music COLD_STORAGE_SECRET=change-me npm start -w @squirmy/adapter-cold-storage
```
