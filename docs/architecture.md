# Squirmy architecture

This is the technical contract for the codebase. [plan.md](./plan.md) says what the product does; this says how the code is laid out and which conventions every module follows. When code and this document disagree, fix one of them in the same change.

## Workspace

```
apps/mobile            @squirmy/mobile        Expo app
apps/web               @squirmy/web           Vite + React web app
apps/server            @squirmy/server        Fastify API, worker, realtime
packages/contracts     @squirmy/contracts     zod schemas and types for every API
packages/client-core   @squirmy/client-core   session reducer, session client, API client
adapters/kit           @squirmy/provider-kit  the provider side of the acquisition protocol
adapters/cold-storage  @squirmy/adapter-cold-storage  reference provider: a folder of your own files
adapters/mock          @squirmy/adapter-mock  provider for tests and demos: quiet tagged tones
```

npm workspaces, Node 22.13 or newer, TypeScript 6, ESM everywhere except the Expo app. `contracts` and `client-core` compile to `dist` with `tsc`; consumers import the built output, so run `npm run build:packages` (or the packages' `dev` watchers) before typechecking or running anything else. The adapters build the same way (`npm run build:adapters`); the root `typecheck`, `test` and `build` scripts build both. The server image installs only the server's workspaces; the adapters are separate services with their own READMEs.

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

1. **Database state.** A module finds its own work by querying for rows that need it (files with no loudness, albums still `pending`). Sweeps make this robust to ordering and restarts. A module may also hold off on work by another module's recorded state: scans skip `_Incoming` folders of imports still moving files, and matching waits for an import to decide its duplicates.
2. **Jobs by name.** A module may enqueue another module's job (`enqueue('loudness.measure', { fileId })`). The job name and payload are that module's public interface.
3. **Seam functions.** A few direct calls are declared up front and start as no-ops: `enrichment/detail.ts` (`ensureAlbumDetail`, `ensureArtistDetail`), `acquisition/coverage.ts` (`onDemandRecordings`, `requestRecording`), `radio/suggest.ts` (`suggestAutoplay`). The owning module fills them in; callers never change. In the other direction, sessions exports `onPlayStart` (`sessions/plays.ts`), a subscription to plays opening on the active device, which scrobble uses for "now playing".

### Configuration

Environment variables are parsed in `config.ts`; see that file for the full list. The ones a self-hoster sets: `DATABASE_URL` (required), `SQUIRMY_DATA_DIR`, `SQUIRMY_LIBRARY_PATHS` (read-only roots) and `SQUIRMY_MANAGED_LIBRARY_PATHS` (managed roots), `SQUIRMY_INBOX_PATH`, `PORT`, `PUBLIC_URL`, `TRUST_PROXY`, `SQUIRMY_ROLE`. `SQUIRMY_SECRET` is generated into the data directory on first boot when unset.

Operator settings that change at runtime (provider toggles, API keys, thresholds) live in the `server_settings` table and are edited in the admin UI. Shape: `ServerSettings` in contracts. Secrets are stored encrypted under separate keys and never returned.

### Data directory

```
<data>/secret.key                     generated root secret (0600)
<data>/assets/ab/cd/<sha256>.<ext>    original images, content addressed; rebuilt from their source when lost
<data>/art/<assetId>/<size>.webp      derived renditions, safe to delete
<data>/transcodes/<fileId>/<profile>.<source>.<ext>  transcodes; <source> is the file's size and mtime
<data>/staging/<importId>/            files being imported
```

### Artwork

Images are rows in `assets`. `storeImage(bytes)` stores an image now and de-duplicates by content. `remoteImage(url)` only records where an image lives; it is downloaded the first time `GET /art/:id/:size` asks for it, so search results for music you do not own can show covers without downloading every one. A failed download answers 404, is not cached, and is retried after an hour. When the source answers 404 or 410 (a release group the Cover Art Archive has no cover for), the asset is also unassigned from the albums and artists showing it, so their summaries stop handing out an id that cannot be served; the discography does not offer that cover again for a week.

Lost originals rebuild themselves (`artwork/recover.ts`). When a file under `assets/` is gone, `readOriginal` (used by renditions and Subsonic's `getCoverArt`) reads it back from disk while the request waits: the folder image of a `folder:` source, or the pictures of the source file and of any present file whose `embedded_art_asset_id` it is. Only bytes with the stored SHA-256 are accepted, so an id never shows a different picture. A URL source is queued as `artwork.recover` and the request answers 404 without cache headers; the job downloads it again (a `remote_url` asset goes back to `remote` and is fetched as on its first request; any other must match its hash). An asset nothing rebuilds is `missing`, answers 404 at once, and is left alone. `artwork.sweep` (daily, 04:40) queues assets whose file is gone, `missing` assets whose file is back, and `missing` assets last tried a week ago.

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
- `publish(target, event)` and `invalidate(target, keys)` are callable from any process. They `NOTIFY squirmy_events` with a JSON payload; the API process `LISTEN`s on a dedicated connection and forwards to rooms. `target` is `{ user: id }`, `'admins'`, `'all'`, or a list of them, which reaches each socket once however many of them it is in (an admin is in their own room and in `admins`). Keys that do not fit in one notification (8000 bytes) are split across several. `disconnectSockets(userId, { only | except })` closes sockets of revoked sessions the same way.
- `time:sync` is answered here; the `session:*` events belong to the `sessions` module.
- Every mutation that changes what another open screen shows calls `invalidate` with keys from `queryKeys`.

### HTTP API

All native routes are under `/api/v1`. Lists are paginated with `PageQuery` and return `{ items, nextCursor }`; short lists (users, invites, app passwords, roots, devices) return every item with `nextCursor: null`. `GET /admin/jobs` returns a bare array. `createApiClient` in client-core has one method per route below, and its response schemas are the reference for each route's shape. `apiRoutes` next to it names each method's route; `client-routes.test.ts` fails when the server registers a native route that no method calls and that is not on its short list of routes clients never call (stream and art URLs, the Last.fm callback, provider deliveries). Uploads go through `XMLHttpRequest`, which reports progress.

| Route | Module | Notes |
|---|---|---|
| `GET /setup/status`, `POST /setup` | auth | create the first admin |
| `POST /auth/login`, `/auth/logout`, `/auth/register`, `/auth/password`; `GET /auth/me` | auth | |
| `GET/POST /auth/app-passwords`, `DELETE /auth/app-passwords/:id` | auth | the secret is returned once, on create |
| `GET/PATCH /me/settings` | userdata | `UserSettings` |
| `GET/POST /admin/users`, `PATCH/DELETE /admin/users/:id`; `GET/POST /admin/invites`, `DELETE /admin/invites/:id` | admin | the last active admin cannot be demoted, disabled or deleted |
| `GET/PATCH /admin/settings`, `GET /admin/jobs`, `GET /admin/fs` | admin | `fs` lists directories only, symlinks resolved; home directory by default |
| `GET/POST/PATCH/DELETE /admin/library/roots`, `POST /admin/library/roots/:id/scan`, `GET /admin/library/stats` | library | a folder that is already a root is 409 `duplicate_root` with `details.rootId`; `template` is checked with organize's `validateTemplate`; a bad one is `invalid_request` with an issue on `template` |
| `GET /library/albums`, `/library/artists`, `/library/tracks`, `/library/genres` | catalog | owned music only; `sort`, `genre` (artists have one order and no genre filter); tracks by `year` follow their album's year, then path order within it |
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
| `GET /me/scrobbling`, `PUT/DELETE /me/scrobbling/listenbrainz`, `POST /me/scrobbling/lastfm/start`, `DELETE /me/scrobbling/lastfm` | scrobble | every mutation returns `ScrobblingStatus` |
| `GET /scrobbling/lastfm/callback` | scrobble | no session needed: the signed `state` names the user; redirects to `/settings?lastfm=…` |
| `POST /radio/track/:id`, `POST /radio/artist/:id` | radio | `RadioResponse`, played with `playTracks` |
| `GET /admin/reviews`, `GET /admin/reviews/:id`, `POST /admin/reviews/:id/resolve`, `GET /admin/albums/:id/candidates`, `POST /admin/albums/:id/rematch`, `/unmatch` | matching | resolve, rematch with a release and unmatch lock the files; candidates come with the album's files |
| `GET /admin/organize/template`, `POST /admin/organize/preview`, `GET /admin/organize/batches`, `GET /admin/organize/batches/:id`, `POST /admin/organize/batches/:id/apply`, `/revert` | organize | apply and revert run as jobs and answer 202 |
| `GET/POST /imports`, `GET /imports/options`, `GET/DELETE /imports/:id`, `GET /imports/:id/albums`, `POST /imports/:id/files`, `POST /imports/:id/commit` | imports | admins and members with `canUpload`; multipart upload; `DELETE` cancels while receiving; a list shows your own imports, or all for an admin; `options` says whether uploads can be filed and gives the size limits |
| `GET/POST /admin/acquisition/providers`, `PATCH/DELETE /admin/acquisition/providers/:id`, `POST /admin/acquisition/providers/:id/test`, `GET/PATCH /admin/acquisition/policy`, `GET /admin/acquisition/jobs` | acquisition | the secret is never returned; `test` calls `capabilities` |
| `POST /tracks/:id/acquire`, `POST /albums/:id/acquire` | acquisition | explicit request, 202 with the jobs; play does it implicitly |
| `POST /acquisition/deliveries/:jobId/files`, `/complete` | acquisition | for providers: the job's bearer token instead of a session; rate limited |
| `GET/DELETE /admin/catalog-index`, `POST/DELETE /admin/catalog-index/import` | catalog-index | see [local-search-index.md](./local-search-index.md) |
| `/rest/*` | subsonic | OpenSubsonic, XML and JSON |

### Availability

One function decides it, in `modules/catalog/availability.ts`, and every list and page uses it:

- Track: `server` if a present (not missing) `media_files` row has its `recording_id`. Otherwise `on_demand` if an enabled acquisition provider covers it (coverage `assume_available`, or a cached positive resolve) and it is not in `acquisition_misses`. Otherwise `none`.
- Album: counts owned tracks on its track list (`albumTrackList`, below): the canonical release, plus owned recordings filed under the album that the release does not list. All owned is `full`, some is `partial`; none owned is `on_demand` when its tracks would be, else `none`. `trackCount` and `ownedTrackCount` count the same list, so an album with a present, linked file is never `none`.

### Catalog read side

- `catalog/summaries.ts` builds every `TrackSummary`, `AlbumSummary` and `ArtistSummary`, in batches with a fixed number of queries. They leave out artwork the art route would answer 404 for: a `missing` asset, or a `failed` download inside the hour before it is tried again. Other modules (search, sessions, userdata) use these rather than writing their own. Subsonic builds its own, because its objects describe files (size, codec, path), but takes availability and redirects from the catalog.
- Ids that come from clients follow `merged_into_id` redirects (`catalog/redirects.ts`); the summary builders do it themselves, so stored queue and playlist ids keep working after a merge. `POST /tracks/summaries` answers a merged id with the row it was merged into and lists, in `requestedIds`, the id each summary was asked for, so `TrackStore` files it under the id the queue holds.
- Lists use keyset cursors (`catalog/pagination.ts`): opaque, tied to one ordering, and stable under ties and concurrent inserts. Title and artist orderings are `sortKey` over the stored `*_key` columns, backed by expression indexes in `schema.ts`.
- A library album has a present file linked to it; a library track has a present file linking its recording; a library artist is credited on a library album.
- An album's track list is `albumTrackList` (`catalog/pages.ts`), for the album page and Subsonic's `getAlbum`: the canonical release's tracks, then owned recordings filed under the album that the release does not list (bonus tracks, files matched with no track) in path order on the last disc, with no position. Subsonic numbers those after the disc's last track. Availability still counts only the canonical tracks.

### Search

`modules/search/`. Both routes return `SearchResults` built with the catalog summary builders, so availability comes out the same as everywhere else. Queries whose `matchKey` is shorter than two characters answer nothing.

- **`top`** (`top.ts`, both routes): the single result a client can lead with, as `{ type, id }` naming an item of the lists, or null. Each result's name is compared with the query by `matchKey`, ignoring a leading "the", "a" or "an" on either side: the whole name, or for albums and tracks "artist title" and "title artist", equal to it (also once edition suffixes are dropped, `editionFreeKey`, since Deezer names most classic albums "… (Remastered 2009)") is the best match; starting with it is next; from five characters, a name one typo away comes last; anything else is never top. Ties go to the match with the article as typed, then to popularity when both sides have one (a track's `popularity`; an album's or artist's is the best of the returned tracks on it or by them, unknown when none came back), then to the item its list ranks higher (the provider's or the library's own order), then artist before album before track. The field is optional in the contract, so older servers and clients are unaffected.

- **`GET /search/library`** (`library.ts`): owned music only (artists credited on an owned track or an album with a present file, albums with a present file, owned tracks). Candidates per kind come from bounded index lookups: a byte-order prefix btree on `name_key`/`title_key`; every split of the query into "artist title" or "title artist", looked up from that artist's rows; albums and tracks whose primary artist's name starts with the query; and, from three characters, trigram word similarity on `name_key` or the whole `match_key` (artist and title, so typos and word order are tolerated). Ranking: exact, then prefix (title, name or artist), then similarity; ties go to the user's plays among their last 1,000, then likes. Each kind is one query run with `enable_seqscan` off, because the planner prices `word_similarity` too low. `performance.test.ts` measures it on 10,000 albums and 150,000 tracks.
- **`GET /search/catalog`**: one provider per request (`providers.ts`), in this order: the local index when `isCatalogIndexReady()`, Deezer when enabled, MusicBrainz when enabled. A provider that throws falls through to the next; `provider` names the one that answered. Identical queries in flight share one provider call, and `cachedFetch` keeps search responses for a day. MusicBrainz free text matches titles only, so "artist title" queries are only understood by the other two. The route runs the library search for the same query and limit alongside the provider call and leaves out of its answer every artist, album and track that the library answer lists, so owned music the provider also found is not shown twice.
- **Stub rows** (`materialize.ts`): results are stored before they are returned, in one transaction per response under the advisory lock `squirmy:search-stubs`. Each result is matched to an existing row by its `external_ids` row (`deezer`, or `musicbrainz` for MusicBrainz and local-index ids), then by MBID, then by key: for artists the one artist with that `name_key`, if exactly one exists and it has no other id from the provider; for albums and tracks the same artist (credit text or primary artist) and the same title once edition suffixes are dropped, owned rows first. Album types must agree unless the row is owned; track lengths must be within 10 s. Only then is a stub inserted:
  - artist: `name`, `name_key`, `detail_level` 0, `mbid` when known, an `external_ids` row, `image_asset_id` from `remoteImage`;
  - album: `title`, `artist_credit`, `primary_artist_id` and `album_artists`, `type`, `year`/`release_date`, `title_key`, `match_key`, `detail_level` 0, `mbid` (release group) when known, an `external_ids` row, `artwork_asset_id` from `remoteImage`, no releases;
  - recording: `title`, `artist_credit`, `primary_artist_id` and `recording_artists`, `duration_ms`, `title_key`, `match_key`, `explicit`, `popularity` (0..1), `isrcs`, `mbid` when known, an `external_ids` row, and `album_hint_id`, an album it appears on. Summaries use the hint only when no file or release track names an album.

  Existing rows only gain a missing external id, image or album hint. Credits without any provider id (the local index names some artists only as text) reuse the artist with that name and otherwise become a stub without an external id.
- **Edition suffixes** (`keys.ts`): a bracketed or dashed suffix is ignored for matching when all its words describe an edition (deluxe, expanded, remastered, anniversary, explicit, clean, bonus tracks, numbers…) and at least one is a strong word, so "OK Computer (Deluxe Edition)" and "Let It Be - Remastered 2009" find the plain titles while "(Live)", "(Remixes)", "(Radio Edit)" and "(Taylor's Version)" stay different albums and songs. Stored keys keep the full title. A catalog query that ends in edition words with at least one strong word ("ok computer deluxe") is also sent without them, and those results follow the whole query's: providers match every word, so an edition they name differently would otherwise find nothing.
- **`search.cleanup`** (daily): deletes stubs older than 30 days that never gained detail (albums and artists at `detail_level` 0 with no MusicBrainz releases, recordings on no release) and that nothing keeps: files, likes, ratings, wants, playlist items, plays, ids in stored playback sessions, acquisition jobs still running, album hints of kept recordings, credits, merges. Their `external_ids` go too; `assets` stay. The library's orphan cleanup leaves stubs alone.

### Playback and streaming

- Clients ask `GET /tracks/:id/playback` and receive a signed URL. The stream route accepts the signature instead of a session so `<audio>`, AVPlayer and downloads need no headers. Signatures bind the file id, profile, user id and an expiry of 12 hours.
- File choice: files of the recording that belong to the requested album first, then lossless over lossy, then higher bitrate. Both ids follow merges, so a queue entry that names an album merged away still gets that album's file.
- `quality=original` serves the file as is when the client's codec list includes its codec, and transcodes to `aac_256` otherwise. `high` is `aac_256`. `data_saver` is `opus_128` when the client lists opus and `mp3_192` otherwise. The mapping lives in `streaming/profiles.ts`.
- Signed URLs carry `exp` (epoch seconds), `uid` and `sig`, an HMAC from `sign('stream', …)`. A request without a valid signature may use the session instead.
- A URL names the file, not its path, so it keeps working when organize files it: a file not at its row's path is looked for at the other end of a move that is running (organize renames on disk before it updates the row), and is marked missing only when it is in neither place. When the library root itself is not a readable folder (an unmounted drive or share) the request answers 503 `root_unavailable` and nothing is marked missing, as the scanner does.
- A transcode is written to the cache while it is streamed to the first requester; later requests get the cached file with Range support. A cached transcode is used only while the source's size and mtime are the ones it was made from, so a file replaced or retagged in place is encoded again. ffmpeg writes to a pipe, so every streamed byte is final: AAC 256k in ADTS (`.aac`), Opus 128k in Ogg, MP3 at constant bitrate without a Xing frame. Encoders: `aac`, `libopus`, `libmp3lame`.
- Requests for the same transcode share one ffmpeg per process; a client that leaves does not stop it. At most half the CPU cores (at least two) encode at once.
- `streaming.transcode` `{ fileId, profile }` builds a transcode ahead of time. `streaming.evict` runs hourly and at worker start: it reconciles rows with files on disk and deletes least-recently-used transcodes beyond `transcodeCacheMaxBytes`, sparing those used in the last half hour so a track being played keeps answering Range requests.
- Normalization values: prefer measured loudness (`-18 − loudness_lufs` gives the gain); fall back to the file's ReplayGain tags. Album values come from `release_loudness`.
- Loudness is EBU R128 from ffmpeg's `ebur128` filter. `loudness.measure` `{ fileId }` stores a file's integrated loudness and true peak, then queues `loudness.album` `{ releaseId }`, which decodes the release's present files in track order through one concat filter, so gating covers the album as a whole. `loudness.sweep` (every 10 minutes and at worker start) queues files with no loudness in batches of 500 and releases whose file set changed. Silent and very short files store -70 LUFS, which yields no gain.

### Sessions

The server holds one session per user in memory, loaded on first use and persisted to `playback_sessions` on change (debounced one second, and flushed on shutdown). This assumes one API process: the copy in memory is the truth, so functions that change sessions (`markRecordingReady`, `replaceQueue`) must run in that process. Commands arrive on the socket, run through `reduceSession` from client-core, and the result is broadcast: `session:state` on every change, `session:queue` only when the queue half changed (`queueChanged`), emitted just before the `session:state` of the same version.

- **Commands.** The server passes the envelope's `commandId` to the reducer (new entry ids derive from it), remembers recent command ids (the last hundred are stored with the session, so they survive a restart along with their effect) and acks a duplicate without applying it again, and acks a command before broadcasting its result. Server-issued commands use a fresh id. A user's commands, reports and hellos run one at a time, in arrival order.
- **Trusted entries.** For `playTracks` and `enqueue` the server keeps only the track ids the client sent: it follows merges, takes durations from the database, drops tracks that are neither owned nor on demand, and sets `ready` or `preparing` itself.
- **Active device.** The first device that can play and sends a command that starts playback while no device is active becomes active. `transfer` changes it, and only to a connected device that can play. Only the active device may send `trackEnded` and engine reports. A report that is more than a second off the computed position, or changes whether playback is stalled, becomes `syncPosition`.
- **Disconnects.** If the active device's last socket closes, the server waits 20 seconds, then applies `deviceLost` as of the moment it went away (pause at the position it had then, or at a later change's, and clear the active device), so neither the resume point nor the play counts the grace period. A session loaded after a restart gives its absent active device the same grace.
- **Plays.** A play row opens when an entry is current and running on the active device and closes when the entry changes or stops at its end. Listened time comes from the session's position arithmetic, so pauses and seeks add nothing. The open play is stored with the session (and written at shutdown under the id it was given when it opened), so a listen across a restart stays one row. Plays under five seconds are skips and leave no row; one counts as completed after half the track or four minutes. A play is written under the recording and album the track's summary resolves to when it closes (merges followed; the album of its file, else of a release), not the entry's ids, so it never lands on a merged-away row or on the catalog stub album an on-demand track was queued from. Writing one invalidates history and home.
- **On demand.** When the current or an upcoming entry is `on_demand`, the acquisition module is asked for it and the entry is `preparing` until the file is linked, then `setEntryState` flips it to `ready` (or `failed`, which skips it; a failure that comes after a current entry became ready leaves that entry playing). Every request gets an answer, so an entry never waits forever; see "Acquisition". A request that throws instead fails the session's entries of that recording.
- **Autoplay.** When the queue is nearly empty and autoplay is on, the radio module supplies `setAutoplayQueue`. `playTracks` empties the autoplay queue, so suggestions always follow what is playing rather than an earlier queue.

### Scrobbling

- **Connections** live on the user row under `settings.secrets.<listenbrainz|lastfm>`: the credential (ListenBrainz user token, Last.fm session key) encrypted with `encrypt('scrobble-credential', …)`, the account name, `since`, `needsAttention` and `lastError`. Connecting verifies the credential (`listenbrainz.validateToken`, Last.fm's web auth flow) and switches the user's `scrobbleListenBrainz`/`scrobbleLastFm` on; disconnecting switches it off and drops unsent rows. Reconnecting the same account keeps `since`, so plays waiting for it are still sent.
- **Last.fm web auth.** `POST /me/scrobbling/lastfm/start` returns Last.fm's approval URL with a callback carrying `state` = user id, expiry (10 minutes) and `sign('lastfm-connect-state', …)`. The callback base is `PUBLIC_URL`, else the request's origin.
- **Sweep.** `scrobble.sweep` (every minute and at worker start) inserts one `scrobble_deliveries` row per service for each completed play of the last 14 days that started at or after `since`: `pending` when the service is switched on, `skipped` when off. It then queues `scrobble.deliver` `{ userId, target }`, keyed by both, where rows are ready.
- **Delivery.** `scrobble.deliver` locks the oldest ready rows (`for update skip locked`) in the service's batch size (ListenBrainz 1000, Last.fm 50), submits them with the MusicBrainz recording, release, release group and artist ids when known, track number, duration, album and start time, and marks them `sent`. A failure counts an attempt and the row waits 1, 2, 4… minutes (at most 6 hours) for the next sweep; after 10 attempts it is `failed` and left alone. A rejected credential (ListenBrainz 401, Last.fm error 9) sets `needsAttention` instead, and rows wait for the user to reconnect.
- **Guarantees.** The row is the idempotency record: one per play and service, submitted while locked, so overlapping sweeps and deliveries send a play once. The one gap is a crash after a service accepted a batch and before the commit, which resends that batch once.
- **Now playing** is sent from the API process when `onPlayStart` fires, best effort and without retries.

### Radio

- `suggestAutoplay` (the seam) and the radio routes rank with `radio/ranking.ts`: profile the seeds (artists, album and artist genres, years), gather a few hundred owned candidates in one query from bounded pools (seed artists, similar artists, albums sharing a genre or era, tracks the user played within half an hour of a seed, liked tracks and artists, a few random albums), score them with the weights in `ranking.ts` plus noise, and pick under variety rules over any ten consecutive tracks, seeds included: two per artist, one per album, three by seed artists, no artist twice in a row. Rules relax only when nothing else fits. `on_demand` tracks are used only when no owned track qualifies. `suggestAutoplay` follows merge redirects of its seeds and exclusions first, so a queue entry holding a merged id still keeps its track out.
- Random sampling in SQL uses `uuid_hash_extended` with a salt drawn from the injected random source, so a seeded source repeats a result exactly.
- `similarArtists(artistId)` merges Deezer related artists (Deezer id from `external_ids`, else an exact name search) and ListenBrainz similar artists (with a server token and an artist MBID), mapped to catalog artists by MBID, else `name_key`. A source that is off or fails is skipped; lookups during ranking give up after 2.5 seconds.
- A radio is 50 tracks starting with the seed track (for an artist, its most played, liked or popular owned track) with context `{ type: 'radio', id: 'track:<id>' | 'artist:<id>' }`. Nothing is stored: when the radio runs out and autoplay is on, the session's history (the radio's last tracks) seeds the next batch, so it continues in the same direction.

### Subsonic

`modules/subsonic` serves OpenSubsonic under `/rest` over the same services; [subsonic.md](./server/subsonic.md) lists what it supports.

- `router.ts` answers every method on GET and form POST, with or without `.view`. Handlers return plain objects that `serialize.ts` writes as XML or JSON(P). Failures are Subsonic error codes in a 200; service `AppError`s map to the closest code (404 is 70, 403 is 50).
- Every request authenticates with an app password (token, password or `apiKey`); failures are limited per IP in the API process.
- Ids carry their kind (`ar-`, `al-`, `tr-`, `pl-`, `ca-` for an artwork asset) and are checked on the way in. Music folders are library roots, numbered by a hash of the root id.
- Only owned music appears. `songs.ts`, `albums.ts` and `artists.ts` build response objects in batches with a fixed number of queries; a song is shown through the present file `selectFile` would stream.
- `search3` and `search2` rank a query with the search module's library search (`searchLibrary`), so typos are tolerated as in the apps. Sync clients page through everything with an empty `search3`. The page that starts where the user's previous one ended continues from its last key, so deep pages cost what the first does.
- `stream` serves originals and the streaming profiles through `openStream`; a bitrate below every profile, or a `timeOffset`, is a live ffmpeg encode that is not cached.
- The play queue is the session queue (`getSnapshot`, `replaceQueue`). The songs a client saved before its current one are remembered in memory while the session's current entry and queue are unchanged.

### Library pipeline

Jobs, in order. Each is idempotent and keyed by file or album group.

1. `library.scan` `{ rootId, paths? }` walks a root, or just the given paths, and compares `(rel_path, size, mtime)` with `media_files`: new files are inserted at `probe_stage 0`, changed ones reset to it, vanished ones get `missing_since` and returning ones lose it. Probes are queued in bulk. The walk (sorted by UTF-8 bytes) and the rows (read in pages, `collate "C"`) are merged like two sorted lists, so memory and queries stay flat whatever the library size. Hidden entries, `@eaDir`, recycle bins and partial downloads are skipped; symlinks are followed only to files inside the root. A root that cannot be read is skipped rather than marked missing. One scan per root at a time; `library.scan-all` runs nightly.
2. `library.probe` reads tags and technical details with `music-metadata` (ffprobe fills gaps and takes over when it cannot parse), normalizes them into `FileTags`, reads ReplayGain (and Opus R128) into the `tag_*` columns, stores the embedded picture, sets `probe_stage 1` and the group key, then queues ingest for the group. A file nothing can read gets `probe_error` and is left alone until it changes.
3. `library.ingest` `{ rootId, groupKey }` creates or reuses local-only catalog rows (artists, album, release, recordings, release tracks) from the group's tags and links the files, in one transaction. Rows the files already use are reused unless another group has more files on them (or as many and an older file), so a group that loses a file keeps its rows whichever of the two is ingested first; rows with a MusicBrainz id in the tags are found by it or created with it, and are never renamed from tags afterwards. A group with a matched or locked file is only relinked. Rows that end up unused (no files, no user data, no MusicBrainz id) are removed. Then album and artist art from the folder and files, lyrics (embedded or a `.lrc` sidecar), and `matching.match-album`. After this step the music is browsable and playable.
4. `library.analyze` (low priority) computes the audio hash and sets `probe_stage 2`. A new file whose hash matches a row whose file is gone is that row moved: the old row takes the new path and keeps its id, links and match state. Then `loudness.measure`.
5. `matching.match-album` `{ rootId, groupKey }` (singleton key `<rootId>:<groupKey>`) upgrades local-only rows to MusicBrainz rows, opens a review, or leaves the files `unmatched`. It applies under the catalog lock, like ingest. `matching.sweep` re-queues groups still `pending` every ten minutes and at worker start. When `PATCH /admin/settings` switches MusicBrainz on, `queueNewlyPossibleMatching` (`matching/retry.ts`) queues a sweep at once; when an AcoustID key appears it queues `matching.retry-fingerprints`, which sets unlocked `unmatched` files with no known AcoustID back to `pending` in groups the matcher would fingerprint (no album artist and title to search by), then sweeps. Groups searched by their tags are not retried: the key could not change their answer. Both leave alone files in `_Incoming/<importId>/` while that import is processing and has no `duplicates_decided_at`, so no provider is asked about copies about to be deleted or about half an album; the import queues their matching once it has decided.
6. `enrichment.album` and `enrichment.artist` (queued by the match) fill in covers, images, bios, Deezer ids and lyrics; see "Enrichment".

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
- **`imports.process`** runs the steps; each is idempotent and records its outcome before the import moves on, so a retried job carries on after a crash. *Extracting* reads each zip in two passes with yauzl (check every entry, then extract into a temporary folder renamed into place); an archive with an unsafe path, a symbolic link, encryption, more than 10,000 entries or more bytes than the import may hold is refused whole, and nested zips are skipped. *Moving* uses organize's mover (rename, or copy, verify and delete) into `<root>/_Incoming/<importId>/`. *Identifying* queues a scan of that folder and watches `media_files`: it marks rows with `source` and `import_id`; once every file has its audio hash (or an error), it decides in one transaction which files are duplicates and deletes them, recording `imports.duplicates_decided_at` and the paths in `work`. A file is a duplicate when the library already has its audio, when an older import still processing has it, or when an earlier path in the same import does, so the outcome does not depend on the order analysis finished in. Then it waits until the rest is ingested and matched, or for an hour, after which duplicates are decided from the hashes known by then and the rest is left for review. *Filing* plans and applies one organize batch for the albums matched with confidence, removes the folder when no audio is left in it, refreshes wants and records the counts.
- **Completion** is read from the row; every status and step change publishes `import.updated` to the owner and admins.
- **Inbox.** One worker (an advisory lock) polls the inbox (`inboxPath`, else `SQUIRMY_INBOX_PATH`) and takes each top-level item once it has been unchanged and readable for five seconds, moving it into staging. What an import does not take, and failed inbox imports, go to `Not imported/<importId>/` in the inbox. The inbox may not overlap a library root or the data folder.
- **`imports.sweep`** (every 15 minutes and at worker start) expires imports stuck receiving, re-queues processing ones and removes orphaned staging folders.

### Acquisition

`modules/acquisition` implements the server side of [provider-protocol.md](./provider-protocol.md). Nothing happens until an admin adds a provider.

- **Providers** are rows in `acquisition_providers`; the secret is encrypted with `encrypt('acquisition-provider-secret', …)`. A provider counts once it is enabled and has answered `capabilities`. The enabled list is cached in memory for 30 seconds (and dropped on every change in that process), so `onDemandRecordings` costs nothing without one. Every call goes through `client.ts`: timeouts, the bearer secret, redirects only within the provider's origin, at most 4 MiB read, contract validation; failures are `ProviderCallError` and end up in `last_error` or the job's `error`.
- **Policy** is the `acquisition_policy` row of `server_settings` (`AcquisitionPolicy`): lossless preference, per-file limit, storage quota, timeout, target root, and the delivery base URL (the policy's, else `PUBLIC_URL`, else localhost).
- **Coverage** (`onDemandRecordings`). An `assume_available` provider covers every recording without a miss newer than a day (`acquisition_misses`). A `must_resolve` provider covers recordings with a positive resolve newer than 30 days (`acquisition_offers`, free offers only). Recordings it has never answered for are collected in memory for a quarter second, queued as `acquisition.resolve` jobs of up to 100, and remembered for ten minutes so lists do not queue them again; when the answers arrive, the tracks, their albums and searches are invalidated.
- **Requests** (`requestRecording` from sessions, the acquire routes). The user must be an admin or have `can_acquire`, a provider without a recent miss must remain, there must be a root to file into, and acquired files must be under the quota (otherwise a `rejected` job is recorded). One job per target is in flight: the `idempotency_key` is `recording:<id>` or `album:<id>` and gets the job id appended when the job ends. A request that cannot go ahead is answered as failed straight away, unless another job is fetching that recording.
- **Jobs.** `acquisition.start` picks an offer (fresh cached offers, else a resolve, providers in priority order), waits for a slot under the provider's `maxConcurrent`, claims the job with a new random token (only its SHA-256 is stored) and calls `acquire`. Deliveries stream into an import of kind `acquisition` (created on the first upload, filed into the policy's root) under the policy's per-file limit. `complete` commits the import, and `acquisition.finish` follows it: while it identifies, every delivered file that is ingested, hashed and not a copy of another library file is checked against the request (`verify.ts`, rules in the protocol document, merging rows with `mergeRecording` where a delivered file is plainly the requested recording) and what it satisfies is announced ready at once; when the import ends the check runs again and decides the job. A recording matching later links to another MusicBrainz id fails then: it gets a miss and its entries fail, except a current entry that is already playing. `acquisition.sweep` (every minute and at worker start) fails jobs past the timeout, polls providers of jobs quiet for a minute, re-queues the start of jobs stuck in `resolving` and the finish of jobs in `importing`, and deletes expired misses and offers.
- **Outcomes reach the sessions** through the `squirmy_acquisition` NOTIFY channel, which the API process applies with `markRecordingReady` / `markRecordingFailed`. Because sessions ask once per load, the API process also reconciles every 30 seconds while a provider is active: recordings of jobs that ended in the last ten minutes are marked ready when owned, and failed when not owned and no job is still on them.
- **Events.** Every status change publishes `acquisition.updated` to the requesting user and to admins.

The reference providers live in `adapters/`. `@squirmy/provider-kit` is the protocol's provider side (HTTP, secret, validation, idempotent jobs, streaming uploads); `adapters/cold-storage` indexes a folder's tags and resolves by MusicBrainz id, ISRC, then artist, title and length; `adapters/mock` synthesizes quiet tones and can be slow, failing, wrong or priced. The server's tests run the mock in-process.

### External metadata

All clients live in `modules/metadata/` and go through `lib/http.ts`:

- `cachedFetch(provider, url, { ttlSeconds, … })` stores responses in `http_cache` and serves them until they expire. 404s are cached for at most six hours, 5xx never; 429/503 are retried honoring `Retry-After`. `cache: 'reload' | 'no-store'` bypasses the cache for one call.
- `rateLimit(key, intervalMs)` reserves the next slot in the `rate_limits` table, so the limit holds across processes. MusicBrainz uses 1100 ms (only against musicbrainz.org; a mirror is not limited).
- User-Agent: `Squirmy/<version> ( https://github.com/IsaacThoman/squirmy )`, with the version from `lib/version.ts`: `SQUIRMY_VERSION` (release images), else `dev+<short commit>` read once at start from git, else `dev`.
- Every provider checks its toggle or key in `ServerSettings` and returns null or an empty list rather than throwing when it is off. "Not found" is null too; a provider failure (network, timeout, 5xx, bad key) throws `ProviderError`.
- Other modules import the clients from `modules/metadata/index.ts`, e.g. `musicbrainz.getRelease(mbid)`.
- Tests never touch the network. `useHttpFixtures(provider)` from `src/test/http.ts` serves recorded responses from `src/test/http/<provider>/` and fails on any unrecorded request. `SQUIRMY_RECORD_HTTP=1` records missing fixtures from the real service.

### Enrichment

The catalog is a lazy cache of MusicBrainz. `enrichment/detail.ts` completes a row when a page opens it; jobs decorate owned music in the background.

- **Album detail** (`ensureAlbumDetail`). An album at `detail_level` 2 fetched in the last 30 days is left alone. With a release-group MBID the group is fetched, the canonical release chosen (`canonical.ts`: best status present, then the most common track count, then CD or digital media, then the earliest date) and written through matching's `upsertRelease`. An album whose files are on a MusicBrainz edition keeps it as canonical; one whose files sit on a local edition (a local album merged into the group's row) takes the chosen release, and its files' recordings are fitted to the release's tracks. Without an MBID a Deezer id is bridged, most reliable first: the MusicBrainz URL relation of the Deezer page, the UPC as a barcode (accepted when its releases share one group), then a release-group search accepted only for one hit scoring 90 or more with the same title and artist. The stub adopts the MBID, or is merged into the row that has it. With no match the track list comes from Deezer (provider-only rows with ISRCs); the album stays at level 1 and the bridge is retried after a day. Recordings without an MBID that stand in for a track of the canonical release are merged into its recording (`fit.ts`) when the release is written: a stub with no file sharing an ISRC with one track, a loose stub of the album's artists (Deezer top tracks carry no ISRC) with the same edition-free title and a length within five seconds, and the recording of a present file filed under the album by that title and length rule only. A detail run that writes nothing does the last part too, only when an indexed check finds such a file, so a track fetched onto a complete album is folded in on the next visit. Deezer track ids are linked by ISRC.
- **Artist detail** (`ensureArtistDetail`). With an MBID: profile and genres, every Deezer page MusicBrainz links, the official discography (`release-group-status=website-default`) as level-1 album rows with a lazy Cover Art Archive cover (`/release-group/<mbid>/front-500`), adopting the album stubs search or Deezer made for the same groups (no MBID, no files, same primary artist, same `editionFreeKey` title, compatible type; a title two groups share adopts nothing), an image (the one the artist has, else Deezer, fanart.tv, Wikidata, all lazy), the English Wikipedia summary as bio, and a 0..1 `popularity` from ListenBrainz (with a token) or Deezer's top tracks, with stubs for tracks the catalog lacks. A Deezer artist is bridged by URL relation, else an unambiguous exact-name search; otherwise its Deezer albums become stubs.
- **Bounds.** One run per row is in flight per process and concurrent callers share it. A page waits at most four seconds from when the run started (so a visit that joins a run an earlier visit started waits only for what is left), then renders what is known with `detailPending: true` on `AlbumDetail`/`ArtistDetail`; the run carries on, invalidates the page when it lands, and `enrichment.album`/`enrichment.artist` is queued a minute later as a safety net. An album with a Deezer id and no track list yet gets Deezer's first: the page renders it (pending) while MusicBrainz is asked, and the Deezer edition becomes the MusicBrainz release when it is written. The seam never throws: a `ProviderError` leaves what was written, and an optional source failing (image, bio, top tracks) only keeps the row below level 2 so the next visit retries.
- **Owned albums** (`enrichment.album`). After detail: a stored cover unless the album has one at least 500 px on its short side (Cover Art Archive release front, then release-group front, then Deezer), Deezer ids by UPC and ISRC, a Wikipedia description, and `enrichment.lyrics` for owned recordings without lyrics. `albums.enriched_at` records success.
- **Lyrics** (`enrichment.lyrics`, and `GET /tracks/:id/lyrics` on demand): LRCLIB by title, artist, album and duration; no match stores a `none` row that is retried after 30 days. Lyrics from files are never replaced.
- `enrichment.sweep` (every 30 minutes and at worker start) queues owned albums without `enriched_at`, their artists below level 2, and owned recordings without lyrics, 200 of each per run.
- **Sources switched on later.** When `PATCH /admin/settings` switches a source on, `markEnrichmentStale` (`stale.ts`) clears `enriched_at` on owned albums (MusicBrainz, Cover Art Archive, Deezer, Wikidata) and drops artists of owned albums from level 2 to 1 (those, a fanart.tv key, a ListenBrainz token), and the sweep redoes them in its batches. Lyrics need nothing: no LRCLIB lookup is made or stored while it is off. `enrichment.new-releases` (weekly) refreshes library artists' discographies; Home's `new-releases` section lists albums from the last 120 days by library artists that have no present file.

## Clients

`client-core` holds everything both clients share and has no React, DOM or React Native imports:

- `reduceSession(state, { command, now, commandId, deviceId })`: the pure session reducer, also run by the server.
- `SessionClient`: owns the socket (through `createSocketTransport` from `@squirmy/client-core/socket`), the clock offset, optimistic commands and reconciliation; exposes a store (`getSnapshot`, `subscribe`) for `useSyncExternalStore`. `save()` and the `restore` option carry the last server state and the unsent commands across a relaunch; a restored session this device was playing comes back paused. On reconnect, commands made offline are followed by the engine's position, and tracks the device ended offline after the server gave up on it are preceded by a transfer back to it, so the server accepts them.
- `PlayerEngine`: the interface each platform implements (`load`, `preload`, `play`, `pause`, `seek`, `setGain`, `stop`, status events), with a `FakeEngine` for tests. `SessionClient` drives it when this device is active.
- `createApiClient({ baseUrl, getToken })`: typed fetch wrapper for every route, returning contract types.
- `TrackStore`: batched, cached `TrackSummary` hydration for queue entries.
- Formatters (`formatDuration`), normalization math (`gainFor(mode, normalization, context)`), and artwork and stream URL helpers.

**Web** (`apps/web`): Vite, React 19, Tailwind 4, Radix primitives, TanStack Query, react-router. Colors and type follow the mobile theme in `apps/mobile/src/theme.ts`. `HTMLAudioElement` plus Web Audio gain implement `PlayerEngine`; the Media Session API mirrors the session.

```
apps/web/src/
  api/                 the API client (`useApi()`), query client, shared queries, form error helpers
  auth/                session queries, route guards, logout
  realtime/            the user's socket.io connection, invalidations, `useServerEvent`
  components/ui/       primitives (button, slider, menu, dialog, …)
  components/music/    covers, cards, rails, track lists
  components/player/   player bar, mini-player, queue, devices, Now Playing
  components/layout/   app shell, sidebar, top bar, tab bar
  components/views/    one presentational view per page; data arrives as props
  components/admin/    admin views, Fix match
  components/imports/  the upload panel, the imports list and an import's detail
  pages/               route containers: fetch data, pass it to a view
  player/              PlayerProvider (SessionClient), LibraryProvider (likes, wants, playlists), OnDemandProvider (fetching)
  player/engine/       WebPlayerEngine, the Media Session adapter, the page's engine
  fixtures/            fictional catalog and an in-memory session, for tests and the /dev pages
```

- **Bootstrap.** One API client (same origin, `client: 'web'`) and one `QueryClient`. Before any route renders, `GET /setup/status` and `GET /auth/me` load. Guards: a server without an admin shows the setup wizard on every route; signed-out visitors go to `/login?next=…`; admin routes need the admin role. Signing in or out only changes the cached `me`, and the guards navigate. A 401 from any request signs out; other failures become a toast with the server's message, unless the query or mutation says it shows them itself (`meta: { silent }`, `meta: { inline }`).
- **Forms** validate with the contract schemas (`useFormSubmit`), show issues under their fields, and map known error codes onto fields.
- **Realtime.** `RealtimeProvider` opens one socket per signed-in user. `invalidate` refreshes the named queries, every reconnect refreshes all of them, and the shell shows a notice when the socket has been down for three seconds. The socket is in the context for `SessionClient`.
- **Audio.** `WebPlayerEngine` alternates two `<audio>` elements, each through its own `GainNode`, so normalization can boost. When the browser refuses to start audio the entry goes to `error` and the shell offers "Enable audio", which calls `unlock()` from the click. `/dev/engine` drives it with tones from `scripts/dev-audio.mjs`; `scripts/e2e-engine.mjs` checks it against the contract in Chromium, `scripts/e2e-auth.mjs` walks the account flows against a fresh server, `scripts/e2e-admin.mjs` the admin flows (setup with a real folder, scans, reviews, Fix match, Organize on disk, the search index), `scripts/e2e-playback.mjs` playback on the demo library (transport, queue, likes, playlists, lyrics, gapless ends, two devices, a second user), and `scripts/e2e-polish.mjs` a server started like the Docker image (setup with its configured folder, naming templates, search's top result, the queue's preparing labels).

- **Data.** Pages read through the hooks in `api/queries.ts`, keyed by `queryKeys`, so the server's invalidations refresh whatever is on screen. Page queries are `silent` and the page shows its own skeleton, error and "Nothing here" (404). Library lists page by cursor as they scroll. Likes and wants are optimistic: `patchEntity` sets `liked`/`wanted` on every cached copy of the entity, and a failure sets it back.
- **Session.** `PlayerProvider` (inside the signed-in routes) runs one `SessionClient` on the realtime socket with the page's engine. `resolvePlayback` asks for the user's `qualityWifi` and the codecs `canPlayType` confirms (Opus only in Ogg); `setNormalization` follows the user's mode. A `TrackStore` hydrates queue, history and autoplay entries; the current track also has its own query so its heart follows likes. Commands send track ids, album ids and durations only, never `none` tracks; `on_demand` ones go as `preparing`. Playback position is a `PositionClock` that reads `getPositionMs()` on animation frames while playing, so only the clocks and the lyrics re-render. The provider also drives the Media Session (while this tab plays), the tab title, Space and the arrow keys, and toasts entries that fail (and skips a track the browser cannot play).
- **Devices.** Each tab claims its device with a Web Lock on the id kept in `localStorage`: the first tab is the browser's device, a second one `<id>-2` ("Chrome on macOS (2)"), so tabs never play at once; a reloading tab waits briefly for its old page's lock and comes back as the same device. The name (default from the user agent) is editable in settings and sent with a fresh hello (`SessionClient.rename`). While another device is active the shell shows "Playing on …" with "Play here", and the volume controls change that device's entry in `volumes`.
- **Admin.** Pages in `pages/admin.tsx` (lazy) feed views in `components/admin/`. Scan progress comes from `scan.progress` events and invalidations; Organize and index imports report progress only in the database, so those screens poll while one runs. `components/admin/FixMatch.tsx` is the entry point other screens use for Fix match (the album page's menu offers it to admins); it loads its dialog on demand. Settings fields save on blur through `DraftField`, which shows the server's refusal under the field. Providers (`/admin/providers`) lists providers, the acquisition policy and every request, refreshed by `acquisition.updated`.
- **Adding music.** `/imports` (lazy, `pages/imports.tsx`) is for admins and members who may upload. `lib/upload.ts` sends the files picked or dropped (folders walked through directory entries, paths kept) a few per request through `imports.addFiles`, which uses `XMLHttpRequest` for progress and reads each file from disk as it goes; it pauses by aborting the request in flight, and a file the server already had is counted as sent on resuming. The upload belongs to the tab, not the page, and the page follows the import through `import.updated` to its albums (`GET /imports/:id/albums`).
- **On demand.** `OnDemandProvider` knows which tracks are being fetched, from the session's `preparing` entries and `acquisition.updated`, so track rows show them preparing anywhere; it also runs "Get this album". Members without `canAcquire` (admins always may fetch) see on-demand tracks as unavailable, with the reason on the row and in its menu.

Catalog data reaches views through props typed with the contracts; session state and user actions come from `PlayerContext` and `LibraryContext`, whose providers are the only code that talks to `SessionClient` and the API. `/dev/kitchen-sink` shows every component state on the fixtures; the `/dev` pages exist only in development builds.

**Mobile** (`apps/mobile`): the existing Expo app. `expo-audio` implements `PlayerEngine`. The token lives in SecureStore. Screens read through TanStack Query with a persisted cache.

```
apps/mobile/
  app/                   expo-router routes; the root layout gates connect → sign-in → (tabs)
  src/account/           server address, auth state machine, AccountProvider, connect, sign-in and settings screens
  src/data/              query hooks, the persisted cache, RealtimeProvider, LibraryProvider (likes and their offline queue, playlists, TrackStore)
  src/downloads/         DownloadManager (queue, sync, removal), its SQLite index and file adapters, DownloadsProvider, the Downloads screen
  src/library/           browse screens' parts: album, artist, playlist and genre pages, song lists, track actions
  src/player/            Now Playing parts, the queue, session view logic (session.ts), lyrics
  src/player/engine/     ExpoAudioEngine (PlayerEngine on expo-audio) and the lock screen adapter
  src/playback.tsx       PlaybackProvider: the SessionClient, its hooks (usePlaybackState, usePosition)
  src/dev/               development-only screens (the engine bench at /dev/engine)
  modules/now-playing/   local Expo module: Now Playing info and remote commands as JS events
```

- **Accounts.** `AccountProvider` owns the auth state: it restores the stored session (holding the splash until the server confirms it, or for at most three seconds offline), creates the API client with the bearer token, and returns to sign-in on a 401. The token and device id go through `Keychain` (`src/account/keychain.ts`), which never rejects: what the keychain refuses is kept in memory for the launch, and the app says once that the next launch will need a sign-in. The server's name, version and invite rule are read again from `GET /setup/status` whenever a server is chosen, so they stay current.
- **Data.** Query keys come from `queryKeys`; lists are infinite queries over the cursor pages. The cache is saved to app storage (expo-sqlite `localStorage`) per server and user, restored before the splash hides, and removed on sign-out. Every response that carries track summaries primes one `TrackStore`, which hydrates queue entries and the lock screen. Likes apply at once through a queue kept in app storage (`LikeQueue`): one that cannot reach the server waits for the next connection, only the last change to an item is sent, and one the server refuses rolls back with a notice.
- **Realtime.** `RealtimeProvider` opens one socket per signed-in session with `auth.token`. `invalidate` refreshes the named queries (and refetches a changed track's like); every reconnect refreshes all of them. The socket is renewed when the app returns after being suspended (no server ping for 30 seconds) and when the network type changes. A refused handshake rechecks `me`, so a revoked session signs out. The app is *offline* once the socket has been down for 2.5 seconds, or at once when launch could not reach the server.
- **Playback.** `PlaybackProvider` runs a `SessionClient` on that socket with `ExpoAudioEngine` (`canBoost: false`) and the user's normalization mode. `resolvePlayback` asks for the entry's album, the quality setting for the current network (Wi-Fi or cellular) and the codecs AVPlayer decodes. Components read the session through `usePlaybackState`; the position is polled with `usePosition` by the few components that show it. While another device is active the engine is stopped and the lock screen cleared. An engine error skips the track with a notice, or pauses when the next one fails too.
- **Lock screen.** Buttons arrive through `connectNowPlaying` as callbacks; the provider turns them into session commands, never engine calls. The system's own pause (calls, unplugged headphones) becomes a session `pause`.
- **Downloads.** `DownloadManager` keeps each recording once per account, whatever albums, playlists, Liked Songs or single-song downloads list it, and drops it when none does. Files come from `GET /tracks/:id/playback?download=1` with the user's download quality, through `expo-file-system` background download tasks, into `Documents/downloads/` under a fresh UUID name; a completed file must match the announced size. Three run at a time; failures retry after 15 s, doubling, and are marked failed after five tries (a 404 at once); on cellular with Wi-Fi only they pause, keeping their resume data, and say so. The index is `downloads.db` (expo-sqlite): one row per account and recording with its file, quality, size, album context and times, plus the track summary, the descriptor (normalization) and retry state as JSON; collections keep their track ids and the album or playlist as last seen, so their pages open offline. Covers are kept at 600 px. Rows are written before files are deleted, and a launch sweep deletes files no row names and re-queues rows whose file is missing or short. Syncs (on reconnect, every six hours, and after `invalidate` of playlists, likes or albums) add tracks new to a downloaded collection, drop removed ones, flag what the server no longer has, and, at most daily per file, re-download a file the server replaced (`fileId` changed) while the old one keeps playing. Sign-out and switch-server remove the account's downloads after saying so.
- **Search.** `searchSections` (`src/library/search.ts`) splits the library and catalog answers into two groups (artists, albums, songs each; catalog results the library already has are dropped) and picks the top result from the library's `top` hint, else the catalog's.
- **On demand.** `canPlay` lets admins and members with `canAcquire` play `on_demand` tracks; for others they are gray. Rows mark them with a cloud, and the row of a current entry that is `preparing` says so.
- **Offline.** `resolvePlayback` returns a downloaded file's descriptor (with its normalization) before asking the server, so downloads never stream; `SessionClient.forgetPlayback()` runs when a download arrives or goes. Offline, only downloads are playable (`canPlay`): other tracks, albums, artists and playlists are gray, actions that need the server are hidden, and a current entry that is not downloaded is skipped. The session is saved (`SessionClient.save()`) with the summaries of its entries, and a relaunch restores it paused; commands made offline reach the server on reconnect.

## Testing

- `vitest` everywhere. A test file sits next to the code it tests as `*.test.ts`.
- **Database tests** call `useTestDatabase()` from `src/test/database.ts`, which clones a migrated template database for the file. They need `SQUIRMY_TEST_DATABASE_URL` (default `postgres://localhost:54329/postgres`). CI provides a Postgres service.
- **Audio fixtures** are generated with ffmpeg by `src/test/audio.ts`: short, very quiet tones with real tags. No real music is committed.
- **HTTP fixtures** for external services are recorded JSON; no live calls in tests. A hand-written fixture may list `request.headers` that must match too, for requests that differ only in a header.
- **Before a change is done:** `npm run build:packages && npm run typecheck && npm run lint && npm test` all pass.

## Git

- Conventional Commits: `type(scope): imperative summary`. `feat` and `fix` drive releases.
- Branches are named like commits: `feat-library-scan`, `fix-range-requests`.
- Pull requests target `dev`. `main` receives merges from `dev`; semantic-release tags a version on every push to `main`.
