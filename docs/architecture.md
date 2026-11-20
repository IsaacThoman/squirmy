# Squirmy architecture

This is the technical contract for the codebase. [plan.md](./plan.md) says what the product does; this says how the code is laid out and which conventions every module follows. When code and this document disagree, fix one of them in the same change.

## Workspace

```
apps/mobile            @squirmy/mobile        Expo app
apps/web               @squirmy/web           Vite + React web app
apps/server            @squirmy/server        Fastify API, worker, realtime
packages/contracts     @squirmy/contracts     zod schemas and types for every API
packages/client-core   @squirmy/client-core   session reducer, session client, API client
```

npm workspaces, Node 22.13 or newer, TypeScript 6, ESM everywhere except the Expo app. `contracts` and `client-core` compile to `dist` with `tsc`; consumers import the built output, so run `npm run build:packages` (or the packages' `dev` watchers) before typechecking or running anything else.

| Command | What it does |
|---|---|
| `npm run build:packages` | Build contracts, then client-core |
| `npm run typecheck` | Typecheck every workspace |
| `npm test` | Run every workspace's tests |
| `npm run lint` | oxlint, warnings are errors |
| `npm run dev:api` | Server on port 4747 with reload |
| `npm run dev:web` | Vite on port 5173, proxying `/api`, `/rest` and `/socket.io` to 4747 |
| `npm run db:generate` | Generate a migration from `schema.ts` |

## Code conventions

- Relative imports end in `.js` in server and packages (NodeNext). No path aliases in server or packages.
- **Contracts first.** Every request and response body is a zod schema in `packages/contracts/src/<domain>.ts`, exported with its inferred type under the same name. Routes parse input with the schema and return objects that satisfy the response type.
- **Units.** Durations are integer milliseconds. Timestamps on the wire are ISO 8601 strings; the session protocol uses epoch milliseconds. Gains are dB; peaks are linear.
- **IDs.** UUIDv7 from `newId()`. Artwork asset ids are UUIDv4 from `newPublicId()`.
- **Errors.** Throw `AppError` (or the helpers in `lib/errors.ts`). The response body is `{ error: { code, message, details? } }`. Codes are stable snake_case strings.
- **Names in the API.** A *track* is a recording. `TrackSummary.id` is the recording id. An *album* is a release group. Clients never see files, releases or recordings as separate concepts, except `fileId` in the playback descriptor.
- **Text matching.** Use `matchKey`, `creditKey` and `sortKey` from `lib/text.ts` for every normalized comparison and for the `*_key` columns.
- **No module-level side effects.** Nothing connects, listens, schedules or reads config at import time. `db` connects on first use.
- **Comments** explain why, not what. No commented-out code.

## Server

```
apps/server/src/
  index.ts              entry: migrate, then start API and/or worker by SQUIRMY_ROLE
  app.ts                buildApp(): Fastify instance, plugins, auth hook, module routes
  config.ts             zod-parsed environment
  database/             client.ts (lazy db), schema.ts, migrate.ts
  lib/                  auth, errors, ids, text, crypto, settings, version, ffmpeg, http, paths
  jobs/                 pg-boss wrapper: jobs.define, enqueue, schedule
  realtime/             socket.io server, rooms, publish/invalidate
  modules/<name>/       one folder per module; see the table below
  test/                 database harness, audio fixtures, factories, http fixtures
```

- **Boot.** `index.ts` migrates, starts jobs, then in API roles builds the app and attaches realtime, calls each module's `jobs`, `realtime` and `start` hooks for its role, and listens last. SIGTERM undoes those steps in reverse. A worker-only process opens no HTTP port.
- **HTTP.** Helmet without CSP, cookies, multipart (streamed, up to 16 GiB per file), and CORS only for the Vite dev origins outside production. Each module's `routes` is registered in its own encapsulated scope under `/api/v1`.
- **Web app.** When `SQUIRMY_WEB_DIST` is set the built app is served, with `index.html` as the fallback for unknown GET paths outside `/api`, `/rest`, `/socket.io`, `/health` and `/ready`. Hashed files under `assets/` are cached as immutable.
- `GET /health` answers without touching anything; `GET /ready` checks the database.

### Modules

Each module is a folder under `modules/` that exports one `ServerModule` from its `index.ts`. `modules/index.ts` lists them all statically. A module only edits files inside its own folder, its own contracts file, and its own tests.

```ts
export type ServerModule = {
  name: string
  /** HTTP routes. Called with an instance already prefixed with /api/v1. */
  routes?: (app: FastifyInstance) => void | Promise<void>
  /** Routes that need their own prefix (Subsonic's /rest). Called with the root instance. */
  rootRoutes?: (app: FastifyInstance) => void | Promise<void>
  /** Job handlers. Called in processes whose role includes the worker. */
  jobs?: (jobs: JobRegistry) => void | Promise<void>
  /** Socket handlers. Called in processes whose role includes the API. */
  realtime?: (realtime: Realtime) => void | Promise<void>
  /** Long-running loops (file watchers, schedulers). `stop` must undo `start`. */
  start?: (context: { role: 'all' | 'api' | 'worker' }) => void | Promise<void>
  stop?: () => void | Promise<void>
}
```

| Module | Owns | Milestone |
|---|---|---|
| `auth` | setup, login, sessions, registration, app passwords, `request.user` | 2 |
| `admin` | users, invites, server settings, job stats, filesystem browser | 2 |
| `library` | roots, scanner, watcher, probe (tags, audio hash), album grouping, local-only catalog rows | 2 |
| `artwork` | asset store, embedded and folder art, renditions, `GET /art/:id/:size` | 2 |
| `catalog` | read side: library lists, artist/album/track pages, track summaries, home, availability | 2 |
| `streaming` | playback descriptor, signed URLs, `GET /stream`, transcode cache | 2 |
| `loudness` | EBU R128 measurement, album loudness, normalization values | 2 |
| `userdata` | likes, ratings, playlists, history, wants, user settings | 2 |
| `sessions` | playback sessions over socket.io, devices, play recording | 2–3 |
| `metadata` | clients for MusicBrainz, Cover Art Archive, Deezer, Wikidata, LRCLIB, ListenBrainz, AcoustID, fanart.tv, Last.fm | 4 |
| `matching` | album matcher, scoring, review queue, fix match, merges | 4 |
| `enrichment` | covers, artist images, bios, lyrics, external ids, new-release feed | 4 |
| `organize` | managed roots: planner, mover, journal, undo, tag writer | 4 |
| `subsonic` | OpenSubsonic API under `/rest` | 5 |
| `search` | library search, search providers, stub rows, catalog resolve | 6 |
| `imports` | web upload, inbox folder, staging, filing into a managed root, fingerprinting | 7 |
| `acquisition` | provider protocol client, jobs, policy, on-demand playback | 8 |
| `scrobble` | ListenBrainz and Last.fm submission | 8 |
| `radio` | autoplay suggestions from similar-artist data | 8 |
| `catalog-index` | optional local search index from MusicBrainz canonical dumps | 8 |

### Seams between modules

Modules reach each other in three ways, in this order of preference:

1. **Database state.** A module finds its own work by querying for rows that need it (files with no loudness, albums still `pending`). Sweeps make this robust to ordering and restarts.
2. **Jobs by name.** A module may enqueue another module's job (`enqueue('loudness.measure', { fileId })`). The job name and payload are that module's public interface.
3. **Seam functions.** A few direct calls are declared up front and start as no-ops: `enrichment/detail.ts` (`ensureAlbumDetail`, `ensureArtistDetail`), `acquisition/coverage.ts` (`onDemandRecordings`, `requestRecording`), `radio/suggest.ts` (`suggestAutoplay`). The owning module fills them in; callers never change.

### Configuration

Environment variables are parsed in `config.ts`; see that file for the full list. The ones a self-hoster sets: `DATABASE_URL` (required), `SQUIRMY_DATA_DIR`, `SQUIRMY_LIBRARY_PATHS`, `SQUIRMY_INBOX_PATH`, `PORT`, `PUBLIC_URL`, `TRUST_PROXY`, `SQUIRMY_ROLE`. `SQUIRMY_SECRET` is generated into the data directory on first boot when unset.

Operator settings that change at runtime (provider toggles, API keys, thresholds) live in the `server_settings` table and are edited in the admin UI. Shape: `ServerSettings` in contracts. Secrets are stored encrypted under separate keys and never returned.

### Data directory

```
<data>/secret.key                     generated root secret (0600)
<data>/assets/ab/cd/<sha256>.<ext>    original images, content addressed
<data>/art/<assetId>/<size>.webp      derived renditions, safe to delete
<data>/transcodes/<fileId>/<profile>.<ext>
<data>/staging/<importId>/            files being imported
```

### Artwork

Images are rows in `assets`. `storeImage(bytes)` stores an image now and de-duplicates by content. `remoteImage(url)` only records where an image lives; it is downloaded the first time `GET /art/:id/:size` asks for it, so search results for music you do not own can show covers without downloading every one. A failed download answers 404, is not cached, and is retried after an hour.

### Authentication

- A session token is 32 random bytes, base64url. Only its SHA-256 is stored (`auth_sessions.token_hash`). Sessions last 180 days, sliding.
- Browsers get it in the `squirmy_session` cookie (httpOnly, SameSite=Lax, Secure when the request is HTTPS). Native clients send `Authorization: Bearer <token>`. The socket takes the same token from the cookie or from `auth.token`.
- Setup, login and register return `{ user, token }` to every client. A request with the header `X-Squirmy-Client: web` also gets the cookie; `GET /auth/me` renews it. Passing a `device` upserts the `devices` row.
- An `onRequest` hook resolves the token for `/api` routes and sets `request.user` (or null) and `request.authSessionId`. `/rest` authenticates each request with Subsonic credentials instead. Route code calls `requireUser(request)` or `requireAdmin(request)` from `lib/auth.ts`.
- **CSRF.** A cookie-authenticated request that is not GET/HEAD/OPTIONS must carry the header `X-Squirmy-Request: 1`. Bearer requests are exempt.
- Passwords are argon2id. Login is rate limited per IP and per username, setup and register per IP, password changes per user. Counters live in the API process's memory.
- Logging out, changing a password (other sessions), and an admin disabling a user or resetting their password end the affected sessions and close their sockets.
- App passwords for Subsonic clients are random secrets stored AES-GCM encrypted (Subsonic token auth needs the clear text) plus a SHA-256 `key_hash` for `apiKey` lookups. `modules/auth/service.ts` exports `verifyAppPassword` and `findAppPasswordByKey`.
- `lib/crypto.ts` derives purpose-specific keys from the root secret with HKDF and exposes `hashToken`, `sign`/`verify` (HMAC-SHA256) and `encrypt`/`decrypt` (AES-256-GCM, base64url output).

### Jobs

`jobs/` wraps pg-boss. Modules never import pg-boss directly.

```ts
jobs.define('library.probe', { concurrency: 4 }, async (data: ProbeJob) => { … })
await enqueue('library.probe', { fileId }, { singletonKey: fileId, priority: 0 })
await schedule('library.scan-all', '0 4 * * *')
```

- Queue names are `<module>.<verb>`.
- Handlers are idempotent: running one twice leaves the same result.
- `enqueue` accepts a transaction (`{ tx }`) so a row and its job commit together. It goes through pg-boss's Drizzle adapter, so the job insert runs on the caller's transaction; there is no outbox.
- `singletonKey` makes a duplicate a no-op while a job with that key is queued, retrying or active. Queues use pg-boss's `exclusive` policy and keyless jobs get a unique key, so only keyed jobs are deduplicated.
- A definition can choose `policy: 'stately'` instead: one queued and one active job per key, so a request made while a job runs is kept as a single follow-up (`library.ingest` uses it). The policy is fixed when the queue is created.
- `enqueueMany(name, items)` inserts many jobs in one statement with the same deduplication.
- Each concurrency slot is its own pg-boss worker and is woken as soon as its job finishes, so a backlog drains continuously rather than waiting out pg-boss's 30 second notify backstop between jobs.
- Failures retry with exponential backoff (default 3 retries). `timeoutSeconds` fails a job that runs too long.
- Every process starts pg-boss: `index.ts` calls `startJobs({ work })` with `work` true for worker roles. Modules' `jobs` hooks run only in worker roles; a process that enqueues a job it has no definition for creates the queue on first use.
- `getQueueStats()` counts jobs live; `GET /admin/jobs` returns it.
- Tests call `startJobs({ work: true })` and then `drainJobs()`, which resolves once no job of a defined queue is ready or active, running retries without waiting out the backoff.
- Heavy work (loudness, transcodes, fingerprints) uses a low priority so tag reading always goes first.

### Realtime

`realtime/` owns the socket.io server. The session protocol is specified in `packages/contracts/src/session.ts`.

- `startRealtime(app)` attaches to the Fastify server before it listens; closing the app closes the socket server.
- The handshake takes the session token from `auth.token` or the `squirmy_session` cookie and is refused without a valid one.
- Each socket joins the room `user:<id>`. Admin sockets also join `admins`. Handlers passed to `onConnection` run after that; register socket listeners before the first `await`.
- `publish(target, event)` and `invalidate(target, keys)` are callable from any process. They `NOTIFY squirmy_events` with a JSON payload; the API process `LISTEN`s on a dedicated connection and forwards to rooms. `target` is `{ user: id }`, `'admins'` or `'all'`. Keys that do not fit in one notification (8000 bytes) are split across several. `disconnectSockets(userId, { only | except })` closes sockets of revoked sessions the same way.
- `time:sync` is answered here; the `session:*` events belong to the `sessions` module.
- Every mutation that changes what another open screen shows calls `invalidate` with keys from `queryKeys`.

### HTTP API

All native routes are under `/api/v1`. Lists are paginated with `PageQuery` and return `{ items, nextCursor }`; short lists (users, invites, app passwords, roots, devices) return every item with `nextCursor: null`. `GET /admin/jobs` returns a bare array. `createApiClient` in client-core has one method per route below, and its response schemas are the reference for each route's shape.

| Route | Module | Notes |
|---|---|---|
| `GET /setup/status`, `POST /setup` | auth | create the first admin |
| `POST /auth/login`, `/auth/logout`, `/auth/register`, `/auth/password`; `GET /auth/me` | auth | |
| `GET/POST /auth/app-passwords`, `DELETE /auth/app-passwords/:id` | auth | the secret is returned once, on create |
| `GET/PATCH /me/settings` | userdata | `UserSettings` |
| `GET/POST /admin/users`, `PATCH/DELETE /admin/users/:id`; `GET/POST /admin/invites`, `DELETE /admin/invites/:id` | admin | the last active admin cannot be demoted, disabled or deleted |
| `GET/PATCH /admin/settings`, `GET /admin/jobs`, `GET /admin/fs` | admin | `fs` lists directories only, symlinks resolved; home directory by default |
| `GET/POST/PATCH/DELETE /admin/library/roots`, `POST /admin/library/roots/:id/scan`, `GET /admin/library/stats` | library | |
| `GET /library/albums`, `/library/artists`, `/library/tracks`, `/library/genres` | catalog | owned music only; `sort`, `genre` |
| `GET /home` | catalog | `HomeResponse` |
| `GET /artists/:id`, `/albums/:id`, `/tracks/:id`, `/tracks/:id/lyrics` | catalog | fetches missing detail on demand; `/tracks/:id` takes `albumId` |
| `POST /tracks/summaries` | catalog | hydrate queue entries |
| `GET /tracks/:id/playback` | streaming | `PlaybackDescriptor` |
| `GET /stream/:fileId`, `/stream/:fileId/:profile` | streaming | signed URL or session; Range |
| `GET /art/:assetId/:size` | artwork | no auth; immutable cache headers |
| `PUT/DELETE /me/likes/:type/:id`, `GET /me/likes/:type` | userdata | |
| `GET/POST /playlists`, `GET/PATCH/DELETE /playlists/:id`, `POST /playlists/:id/items`, `POST /playlists/:id/items/move`, `DELETE /playlists/:id/items/:itemId` | userdata | |
| `GET /me/history`, `GET /me/wants`, `PUT/DELETE /me/wants/:type/:id` | userdata | |
| `GET /me/session`, `GET /me/devices` | sessions | HTTP view of the socket state |
| `GET /search/library`, `GET /search/catalog` | search | both return `SearchResults` |
| `GET /admin/reviews`, `GET /admin/reviews/:id`, `POST /admin/reviews/:id/resolve`, `GET /admin/albums/:id/candidates`, `POST /admin/albums/:id/rematch`, `/unmatch` | matching | resolve, rematch with a release and unmatch lock the files |
| `POST /admin/organize/preview`, `GET /admin/organize/batches`, `GET /admin/organize/batches/:id`, `POST /admin/organize/batches/:id/apply`, `/revert` | organize | apply and revert run as jobs and answer 202 |
| `GET/POST /imports`, `GET/DELETE /imports/:id`, `POST /imports/:id/files`, `POST /imports/:id/commit` | imports | admins and members with `canUpload`; multipart upload; `DELETE` cancels while receiving; a list shows your own imports, or all for an admin |
| `GET/POST/PATCH/DELETE /admin/acquisition/providers`, `GET /admin/acquisition/jobs` | acquisition | |
| `POST /tracks/:id/acquire`, `POST /albums/:id/acquire` | acquisition | explicit request; play does it implicitly |
| `GET/DELETE /admin/catalog-index`, `POST /admin/catalog-index/import` | catalog-index | see [local-search-index.md](./local-search-index.md) |
| `/rest/*` | subsonic | OpenSubsonic, XML and JSON |

### Availability

One function decides it, in `modules/catalog/availability.ts`, and every list and page uses it:

- Track: `server` if a present (not missing) `media_files` row has its `recording_id`. Otherwise `on_demand` if an enabled acquisition provider covers it (coverage `assume_available`, or a cached positive resolve) and it is not in `acquisition_misses`. Otherwise `none`.
- Album: counts owned tracks on the canonical release. All owned is `full`, some is `partial`; none owned is `on_demand` when its tracks would be, else `none`.

### Catalog read side

- `catalog/summaries.ts` builds every `TrackSummary`, `AlbumSummary` and `ArtistSummary`, in batches with a fixed number of queries. Other modules (search, sessions, Subsonic, userdata) use these rather than writing their own.
- Ids that come from clients follow `merged_into_id` redirects (`catalog/redirects.ts`); the summary builders do it themselves, so stored queue and playlist ids keep working after a merge.
- Lists use keyset cursors (`catalog/pagination.ts`): opaque, tied to one ordering, and stable under ties and concurrent inserts. Title and artist orderings are `sortKey` over the stored `*_key` columns, backed by expression indexes in `schema.ts`.
- A library album has a present file linked to it; a library track has a present file linking its recording; a library artist is credited on a library album.

### Playback and streaming

- Clients ask `GET /tracks/:id/playback` and receive a signed URL. The stream route accepts the signature instead of a session so `<audio>`, AVPlayer and downloads need no headers. Signatures bind the file id, profile, user id and an expiry of 12 hours.
- File choice: files of the recording that belong to the requested album first, then lossless over lossy, then higher bitrate.
- `quality=original` serves the file as is when the client's codec list includes its codec, and transcodes to `aac_256` otherwise. `high` is `aac_256`. `data_saver` is `opus_128` when the client lists opus and `mp3_192` otherwise. The mapping lives in `streaming/profiles.ts`.
- Signed URLs carry `exp` (epoch seconds), `uid` and `sig`, an HMAC from `sign('stream', …)`. A request without a valid signature may use the session instead.
- A transcode is written to the cache while it is streamed to the first requester; later requests get the cached file with Range support. ffmpeg writes to a pipe, so every streamed byte is final: AAC 256k in ADTS (`.aac`), Opus 128k in Ogg, MP3 at constant bitrate without a Xing frame. Encoders: `aac`, `libopus`, `libmp3lame`.
- Requests for the same transcode share one ffmpeg per process; a client that leaves does not stop it. At most half the CPU cores (at least two) encode at once.
- `streaming.transcode` `{ fileId, profile }` builds a transcode ahead of time. `streaming.evict` runs hourly and at worker start: it reconciles rows with files on disk and deletes least-recently-used transcodes beyond `transcodeCacheMaxBytes`.
- Normalization values: prefer measured loudness (`-18 − loudness_lufs` gives the gain); fall back to the file's ReplayGain tags. Album values come from `release_loudness`.
- Loudness is EBU R128 from ffmpeg's `ebur128` filter. `loudness.measure` `{ fileId }` stores a file's integrated loudness and true peak, then queues `loudness.album` `{ releaseId }`, which decodes the release's present files in track order through one concat filter, so gating covers the album as a whole. `loudness.sweep` (every 10 minutes and at worker start) queues files with no loudness in batches of 500 and releases whose file set changed. Silent and very short files store -70 LUFS, which yields no gain.

### Sessions

The server holds one session per user in memory, loaded on first use and persisted to `playback_sessions` on change (debounced one second, and flushed on shutdown). This assumes one API process: the copy in memory is the truth, so functions that change sessions (`markRecordingReady`, `replaceQueue`) must run in that process. Commands arrive on the socket, run through `reduceSession` from client-core, and the result is broadcast: `session:state` on every change, `session:queue` only when the queue half changed (`queueChanged`), emitted just before the `session:state` of the same version.

- **Commands.** The server passes the envelope's `commandId` to the reducer (new entry ids derive from it), remembers recent command ids and acks a duplicate without applying it again, and acks a command before broadcasting its result. Server-issued commands use a fresh id. A user's commands, reports and hellos run one at a time, in arrival order.
- **Trusted entries.** For `playTracks` and `enqueue` the server keeps only the track ids the client sent: it follows merges, takes durations from the database, drops tracks that are neither owned nor on demand, and sets `ready` or `preparing` itself.
- **Active device.** The first device that can play and sends a command that starts playback while no device is active becomes active. `transfer` changes it, and only to a connected device that can play. Only the active device may send `trackEnded` and engine reports. A report that is more than a second off the computed position, or changes whether playback is stalled, becomes `syncPosition`.
- **Disconnects.** If the active device's last socket closes, the server waits 20 seconds, then applies `deviceLost` (pause at the last known position, clear the active device). A session loaded after a restart gives its absent active device the same grace.
- **Plays.** A play row opens when an entry is current and running on the active device and closes when the entry changes or stops at its end. Listened time comes from the session's position arithmetic, so pauses and seeks add nothing. Plays under five seconds are skips and leave no row; one counts as completed after half the track or four minutes. Writing one invalidates history and home.
- **On demand.** When the current or an upcoming entry is `on_demand`, the acquisition module is asked for it and the entry is `preparing` until the file is linked, then `setEntryState` flips it to `ready`.
- **Autoplay.** When the queue is nearly empty and autoplay is on, the radio module supplies `setAutoplayQueue`.

### Library pipeline

Jobs, in order. Each is idempotent and keyed by file or album group.

1. `library.scan` `{ rootId, paths? }` walks a root, or just the given paths, and compares `(rel_path, size, mtime)` with `media_files`: new files are inserted at `probe_stage 0`, changed ones reset to it, vanished ones get `missing_since` and returning ones lose it. Probes are queued in bulk. The walk (sorted by UTF-8 bytes) and the rows (read in pages, `collate "C"`) are merged like two sorted lists, so memory and queries stay flat whatever the library size. Hidden entries, `@eaDir`, recycle bins and partial downloads are skipped; symlinks are followed only to files inside the root. A root that cannot be read is skipped rather than marked missing. One scan per root at a time; `library.scan-all` runs nightly.
2. `library.probe` reads tags and technical details with `music-metadata` (ffprobe fills gaps and takes over when it cannot parse), normalizes them into `FileTags`, reads ReplayGain (and Opus R128) into the `tag_*` columns, stores the embedded picture, sets `probe_stage 1` and the group key, then queues ingest for the group. A file nothing can read gets `probe_error` and is left alone until it changes.
3. `library.ingest` `{ rootId, groupKey }` creates or reuses local-only catalog rows (artists, album, release, recordings, release tracks) from the group's tags and links the files, in one transaction. Rows the files already use are reused unless another group uses them; rows with a MusicBrainz id in the tags are found by it or created with it, and are never renamed from tags afterwards. A group with a matched or locked file is only relinked. Rows that end up unused (no files, no user data, no MusicBrainz id) are removed. Then album and artist art from the folder and files, lyrics (embedded or a `.lrc` sidecar), and `matching.match-album`. After this step the music is browsable and playable.
4. `library.analyze` (low priority) computes the audio hash and sets `probe_stage 2`. A new file whose hash matches a row whose file is gone is that row moved: the old row takes the new path and keeps its id, links and match state. Then `loudness.measure`.
5. `matching.match-album` `{ rootId, groupKey }` (singleton key `<rootId>:<groupKey>`) upgrades local-only rows to MusicBrainz rows, opens a review, or leaves the files `unmatched`. It applies under the catalog lock, like ingest. `matching.sweep` re-queues groups still `pending` every ten minutes and at worker start.
6. `enrichment.*` (milestone 4) fills in covers, images, bios and lyrics.

`library.purge-missing` runs daily and deletes files missing longer than `missingFileGraceDays`. The grouping and album artist rules are written out at the top of `modules/library/grouping.ts`. In short, the album grouping key is root id, parent directory (ignoring `CD1`/`Disc 2` subfolders), and `matchKey` of album artist and album.

Watching: roots with `watch` on are watched while a worker runs, and changed paths are scanned after two quiet seconds. macOS and Windows use one recursive watch per root; Linux uses one inotify watch per folder. Network mounts and exhausted inotify limits fall back to the nightly scan.

Scans skip `_Incoming/<importId>` folders while that import is extracting or moving files into them, and organize leaves `_Incoming` out of its plans unless `includeIncoming` is set.

### Imports

`modules/imports` brings music in through the server: web uploads, the inbox folder, and acquisition deliveries (which call `createImport`, `addImportFile`, `commitImport` and `failImport` from `modules/imports/index.ts`). Whatever the origin, an import is a row in `imports` and goes through the same steps:

```
receiving ──commit──▶ processing: extracting → moving → identifying → filing ──▶ completed
    │                                                                       └──▶ failed
    └── cancel, provider failure, or a day without files ──▶ failed
```

- **Receiving.** Files stream into `<data>/staging/<importId>/` through a byte counter, as a temporary dot file, and are linked into place in the same transaction that bumps the import's counters, so a concurrent commit or cancel sees all of a file or none of it. Names are checked first (`imports/paths.ts`): audio by the scanner's extension list, `cover.*` and `folder.*` images, `.lrc`, `.cue`, `.log` and `.zip`; relative paths are normalized and must not be absolute or contain `..` or control characters, at most 8 levels and 1024 bytes. `importMaxFileBytes` and `importMaxBytes` bound files and imports (413). Nothing follows or creates a symbolic link.
- **Target root.** `importRootId`, else the only enabled managed root; otherwise creating an import fails with `no_managed_root` or `import_root_not_set`.
- **`imports.process`** runs the steps; each is idempotent and records its outcome before the import moves on, so a retried job carries on after a crash. *Extracting* reads each zip in two passes with yauzl (check every entry, then extract into a temporary folder renamed into place); an archive with an unsafe path, a symbolic link, encryption, more than 10,000 entries or more bytes than the import may hold is refused whole, and nested zips are skipped. *Moving* uses organize's mover (rename, or copy, verify and delete) into `<root>/_Incoming/<importId>/`. *Identifying* queues a scan of that folder and watches `media_files`: it marks rows with `source` and `import_id`, deletes files whose audio hash a present library file already has, and waits until every file is hashed, ingested and matched, or for an hour, after which the rest is left for review. *Filing* plans and applies one organize batch for the albums matched with confidence, removes the folder when no audio is left in it, refreshes wants and records the counts.
- **Completion** is read from the row; every status and step change publishes `import.updated` to the owner and admins.
- **Inbox.** One worker (an advisory lock) polls the inbox (`inboxPath`, else `SQUIRMY_INBOX_PATH`) and takes each top-level item once it has been unchanged and readable for five seconds, moving it into staging. What an import does not take, and failed inbox imports, go to `Not imported/<importId>/` in the inbox. The inbox may not overlap a library root or the data folder.
- **`imports.sweep`** (every 15 minutes and at worker start) expires imports stuck receiving, re-queues processing ones and removes orphaned staging folders.

### External metadata

All clients live in `modules/metadata/` and go through `lib/http.ts`:

- `cachedFetch(provider, url, { ttlSeconds, … })` stores responses in `http_cache` and serves them until they expire. 404s are cached for at most six hours, 5xx never; 429/503 are retried honoring `Retry-After`. `cache: 'reload' | 'no-store'` bypasses the cache for one call.
- `rateLimit(key, intervalMs)` reserves the next slot in the `rate_limits` table, so the limit holds across processes. MusicBrainz uses 1100 ms (only against musicbrainz.org; a mirror is not limited).
- User-Agent: `Squirmy/<version> ( https://github.com/IsaacThoman/squirmy )`.
- Every provider checks its toggle or key in `ServerSettings` and returns null or an empty list rather than throwing when it is off. "Not found" is null too; a provider failure (network, timeout, 5xx, bad key) throws `ProviderError`.
- Other modules import the clients from `modules/metadata/index.ts`, e.g. `musicbrainz.getRelease(mbid)`.
- Tests never touch the network. `useHttpFixtures(provider)` from `src/test/http.ts` serves recorded responses from `src/test/http/<provider>/` and fails on any unrecorded request. `SQUIRMY_RECORD_HTTP=1` records missing fixtures from the real service.

## Clients

`client-core` holds everything both clients share and has no React, DOM or React Native imports:

- `reduceSession(state, { command, now, commandId, deviceId })`: the pure session reducer, also run by the server.
- `SessionClient`: owns the socket (through `createSocketTransport` from `@squirmy/client-core/socket`), the clock offset, optimistic commands and reconciliation; exposes a store (`getSnapshot`, `subscribe`) for `useSyncExternalStore`.
- `PlayerEngine`: the interface each platform implements (`load`, `preload`, `play`, `pause`, `seek`, `setGain`, `stop`, status events), with a `FakeEngine` for tests. `SessionClient` drives it when this device is active.
- `createApiClient({ baseUrl, getToken })`: typed fetch wrapper for every route, returning contract types.
- `TrackStore`: batched, cached `TrackSummary` hydration for queue entries.
- Formatters (`formatDuration`), normalization math (`gainFor(mode, normalization, context)`), and artwork and stream URL helpers.

**Web** (`apps/web`): Vite, React 19, Tailwind 4, Radix primitives, TanStack Query, react-router. Colors and type follow the mobile theme in `apps/mobile/src/theme.ts`. `HTMLAudioElement` plus Web Audio gain implement `PlayerEngine`; the Media Session API mirrors the session.

```
apps/web/src/
  components/ui/       primitives (button, slider, menu, dialog, …)
  components/music/    covers, cards, rails, track lists
  components/player/   player bar, mini-player, queue, devices, Now Playing
  components/layout/   app shell, sidebar, top bar, tab bar
  components/views/    one presentational view per page; data arrives as props
  pages/               route containers: fetch data, pass it to a view
  player/              PlayerContext (session state and commands) and LibraryContext (likes, wants)
  fixtures/            fictional catalog and an in-memory session, until the API is wired
```

Catalog data reaches views through props typed with the contracts; session state and user actions come from `PlayerContext` and `LibraryContext`, whose providers are the only code that talks to `SessionClient` and the API. `/dev/kitchen-sink` shows every component state.

**Mobile** (`apps/mobile`): the existing Expo app. `expo-audio` implements `PlayerEngine`. The token lives in SecureStore. Screens read through TanStack Query with a persisted cache.

## Testing

- `vitest` everywhere. A test file sits next to the code it tests as `*.test.ts`.
- **Database tests** call `useTestDatabase()` from `src/test/database.ts`, which clones a migrated template database for the file. They need `SQUIRMY_TEST_DATABASE_URL` (default `postgres://localhost:54329/postgres`). CI provides a Postgres service.
- **Audio fixtures** are generated with ffmpeg by `src/test/audio.ts`: short, very quiet tones with real tags. No real music is committed.
- **HTTP fixtures** for external services are recorded JSON; no live calls in tests.
- **Before a change is done:** `npm run build:packages && npm run typecheck && npm run lint && npm test` all pass.

## Git

- Conventional Commits: `type(scope): imperative summary`. `feat` and `fix` drive releases.
- Branches are named like commits: `feat-library-scan`, `fix-range-requests`.
- Pull requests target `dev`. `main` receives merges from `dev`; semantic-release tags a version on every push to `main`.
