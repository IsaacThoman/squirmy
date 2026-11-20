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
  lib/                  errors, ids, text, crypto, ffmpeg, http, paths
  jobs/                 pg-boss wrapper: defineJob, enqueue, schedule
  realtime/             socket.io server, rooms, publish/invalidate
  modules/<name>/       one folder per module; see the table below
  test/                 database harness, audio fixtures, factories, http fixtures
```

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
| `metadata` | clients for MusicBrainz, Cover Art Archive, Deezer, Wikidata, LRCLIB, ListenBrainz, AcoustID, fanart.tv | 4 |
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

### Configuration

Environment variables are parsed in `config.ts`; see that file for the full list. The ones a self-hoster sets: `DATABASE_URL` (required), `SQUIRMY_DATA_DIR`, `SQUIRMY_LIBRARY_PATHS`, `PORT`, `PUBLIC_URL`, `TRUST_PROXY`, `SQUIRMY_ROLE`. `SQUIRMY_SECRET` is generated into the data directory on first boot when unset.

Operator settings that change at runtime (provider toggles, API keys, thresholds) live in the `server_settings` table and are edited in the admin UI. Shape: `ServerSettings` in contracts. Secrets are stored encrypted under separate keys and never returned.

### Data directory

```
<data>/secret.key                     generated root secret (0600)
<data>/assets/ab/cd/<sha256>.<ext>    original images, content addressed
<data>/art/<assetId>/<size>.webp      derived renditions, safe to delete
<data>/transcodes/<fileId>/<profile>.<ext>
<data>/staging/<importId>/            files being imported
```

### Authentication

- A session token is 32 random bytes, base64url. Only its SHA-256 is stored (`auth_sessions.token_hash`). Sessions last 180 days, sliding.
- Browsers get it in the `squirmy_session` cookie (httpOnly, SameSite=Lax, Secure when the request is HTTPS). Native clients send `Authorization: Bearer <token>`. The socket takes the same token from the cookie or from `auth.token`.
- An `onRequest` hook resolves the token and sets `request.user` (or null). Route code calls `requireUser(request)` or `requireAdmin(request)`.
- **CSRF.** A cookie-authenticated request that is not GET/HEAD must carry the header `X-Squirmy-Request: 1`. Bearer requests are exempt.
- Passwords are argon2id. Login is rate limited per IP and per username.
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
- `enqueue` accepts a transaction so a row and its job commit together.
- Heavy work (loudness, transcodes, fingerprints) uses a low priority so tag reading always goes first.

### Realtime

`realtime/` owns the socket.io server. The session protocol is specified in `packages/contracts/src/session.ts`.

- Each socket joins the room `user:<id>`. Admin sockets also join `admins`.
- `publish(target, event)` and `invalidate(target, keys)` are callable from any process. They `NOTIFY squirmy_events` with a JSON payload; the API process `LISTEN`s and forwards to rooms. `target` is a user id, `'admins'` or `'all'`.
- Every mutation that changes what another open screen shows calls `invalidate` with keys from `queryKeys`.

### HTTP API

All native routes are under `/api/v1`. Lists are paginated with `PageQuery` and return `{ items, nextCursor }`.

| Route | Module | Notes |
|---|---|---|
| `GET /setup/status`, `POST /setup` | auth | create the first admin |
| `POST /auth/login`, `/auth/logout`, `/auth/register`, `/auth/password`; `GET /auth/me` | auth | |
| `GET/POST/DELETE /auth/app-passwords` | auth | |
| `GET/PATCH /me/settings` | userdata | `UserSettings` |
| `GET/POST/PATCH/DELETE /admin/users`, `/admin/invites` | admin | |
| `GET/PATCH /admin/settings`, `GET /admin/jobs`, `GET /admin/fs` | admin | |
| `GET/POST/PATCH/DELETE /admin/library/roots`, `POST /admin/library/roots/:id/scan`, `GET /admin/library/stats` | library | |
| `GET /library/albums`, `/library/artists`, `/library/tracks`, `/library/genres` | catalog | owned music only; `sort`, `genre` |
| `GET /home` | catalog | `HomeResponse` |
| `GET /artists/:id`, `/albums/:id`, `/tracks/:id`, `/tracks/:id/lyrics` | catalog | fetches missing detail on demand |
| `POST /tracks/summaries` | catalog | hydrate queue entries |
| `GET /tracks/:id/playback` | streaming | `PlaybackDescriptor` |
| `GET /stream/:fileId`, `/stream/:fileId/:profile` | streaming | signed URL or session; Range |
| `GET /art/:assetId/:size` | artwork | no auth; immutable cache headers |
| `PUT/DELETE /me/likes/:type/:id`, `GET /me/likes/:type` | userdata | |
| `GET/POST /playlists`, `GET/PATCH/DELETE /playlists/:id`, `POST /playlists/:id/items`, `POST /playlists/:id/items/move`, `DELETE /playlists/:id/items/:itemId` | userdata | |
| `GET /me/history`, `GET /me/wants`, `PUT/DELETE /me/wants/:type/:id` | userdata | |
| `GET /me/session`, `GET /me/devices` | sessions | HTTP view of the socket state |
| `GET /search/library`, `GET /search/catalog` | search | both return `SearchResults` |
| `GET /admin/reviews`, `POST /admin/reviews/:id/resolve`, `POST /admin/albums/:id/rematch`, `GET /admin/albums/:id/candidates` | matching | |
| `POST /admin/organize/preview`, `GET /admin/organize/batches`, `POST /admin/organize/batches/:id/apply`, `/revert` | organize | |
| `POST /imports`, `POST /imports/:id/files`, `POST /imports/:id/commit`, `GET /imports/:id` | imports | multipart upload |
| `GET/POST/PATCH/DELETE /admin/acquisition/providers`, `GET /admin/acquisition/jobs` | acquisition | |
| `POST /tracks/:id/acquire`, `POST /albums/:id/acquire` | acquisition | explicit request; play does it implicitly |
| `/rest/*` | subsonic | OpenSubsonic, XML and JSON |

### Availability

One function decides it, in `modules/catalog/availability.ts`, and every list and page uses it:

- Track: `server` if a present (not missing) `media_files` row has its `recording_id`. Otherwise `on_demand` if an enabled acquisition provider covers it (coverage `assume_available`, or a cached positive resolve) and it is not in `acquisition_misses`. Otherwise `none`.
- Album: counts owned tracks on the canonical release. All owned is `full`, some is `partial`; none owned is `on_demand` when its tracks would be, else `none`.

### Playback and streaming

- Clients ask `GET /tracks/:id/playback` and receive a signed URL. The stream route accepts the signature instead of a session so `<audio>`, AVPlayer and downloads need no headers. Signatures bind the file id, profile, user id and an expiry of 12 hours.
- File choice: files of the recording that belong to the requested album first, then lossless over lossy, then higher bitrate.
- `quality=original` serves the file as is when the client's codec list includes its codec, and transcodes to `aac_256` otherwise. `high` is `aac_256`. `data_saver` is `opus_128` when the client lists opus and `mp3_192` otherwise. The mapping lives in `streaming/profiles.ts`.
- A transcode is written to the cache while it is streamed to the first requester; later requests get the cached file with Range support.
- Normalization values: prefer measured loudness (`-18 − loudness_lufs` gives the gain); fall back to the file's ReplayGain tags. Album values come from `release_loudness`.

### Sessions

The server holds one session per user in memory, persisted to `playback_sessions` on change (debounced one second). Commands arrive on the socket, run through `reduceSession` from client-core, and the result is broadcast: `session:state` on every change, `session:queue` only when the queue half changed.

- **Active device.** The first device that sends a command that starts playback while no device is active becomes active. `transfer` changes it. Only the active device may send `trackEnded` and engine reports.
- **Disconnects.** If the active device's last socket closes, the server waits 20 seconds, then applies `deviceLost` (pause at the last known position, clear the active device).
- **Plays.** A play row opens when an entry starts on the active device and closes when it ends or changes. It counts as completed after half the track or four minutes.
- **On demand.** When the current or an upcoming entry is `on_demand`, the acquisition module is asked for it and the entry is `preparing` until the file is linked, then `setEntryState` flips it to `ready`.
- **Autoplay.** When the queue is nearly empty and autoplay is on, the radio module supplies `setAutoplayQueue`.

### Library pipeline

Jobs, in order. Each is idempotent and keyed by file or album group.

1. `library.scan` walks a root, compares `(rel_path, size, mtime)`, inserts or updates `media_files` at `probe_stage 0`, marks vanished files `missing_since`, and enqueues probes.
2. `library.probe` reads tags and technical details with `music-metadata`, stores embedded art, and sets `probe_stage 1`. It then calls `library.ingest` for the file's album group.
3. `library.ingest` creates or reuses local-only catalog rows (artist, album, release, recordings, release tracks) from the group's tags and links the files. After this step the music is browsable and playable.
4. `library.analyze` (low priority) computes the audio hash and loudness, sets `probe_stage 2`, and reconnects moved files by hash.
5. `matching.match-album` (milestone 4) upgrades local-only rows to MusicBrainz rows or opens a review.
6. `enrichment.*` (milestone 4) fills in covers, images, bios and lyrics.

Album grouping key: root id, parent directory (ignoring `CD1`/`Disc 2` subfolders), and `matchKey` of album artist and album.

### External metadata

All clients live in `modules/metadata/` and go through `lib/http.ts`:

- `cachedFetch(provider, url, { ttl })` stores responses in `http_cache` and serves them until they expire.
- `rateLimit(key, intervalMs)` reserves the next slot in the `rate_limits` table, so the limit holds across processes. MusicBrainz uses 1100 ms.
- User-Agent: `Squirmy/<version> ( https://github.com/IsaacThoman/squirmy )`.
- Every provider checks its toggle in `ServerSettings` and returns "unavailable" rather than throwing when it is off.
- Tests never touch the network. They load recorded responses from `src/test/http/<provider>/` through a `fetch` stub.

## Clients

`client-core` holds everything both clients share and has no React, DOM or React Native imports:

- `reduceSession(state, { command, now })`: the pure session reducer, also run by the server.
- `SessionClient`: owns the socket, the clock offset, optimistic commands and reconciliation; exposes a store (`getSnapshot`, `subscribe`) for `useSyncExternalStore`.
- `PlayerEngine`: the interface each platform implements (`load`, `preload`, `play`, `pause`, `seek`, `setVolume`, status events). `SessionClient` drives it when this device is active.
- `createApiClient({ baseUrl, getToken })`: typed fetch wrapper for every route, returning contract types.
- Formatters (`formatDuration`), normalization math (`gainFor(mode, normalization, context)`), and artwork URL helpers.

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
