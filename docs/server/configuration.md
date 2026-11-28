# Configuration

Squirmy has two kinds of settings:

- **Environment variables**, read once when the process starts. They say where things are: the database, the data folder, the address the server is reached at. Change them in `compose.yaml` or `.env` and restart.
- **Server settings**, stored in the database and changed while the server runs, in **Admin → Server settings**. They control metadata sources, API keys, matching and limits. Every setting can also be changed through the API.

## The ones that matter

| Variable | Why you care |
|---|---|
| `PUBLIC_URL` | The address people use, such as `https://music.example.com`. Set it whenever Squirmy sits behind a reverse proxy or is reached by a name the server cannot see. It is used for [passkeys](./authentication.md#passkeys) (which need it to be `https://`), Last.fm's sign-in callback, artwork links handed to Subsonic apps, and the delivery address given to acquisition providers. |
| `TRUST_PROXY` | Set to `true` when one reverse proxy on the same machine or network sends `X-Forwarded-*` headers. Behind a Cloudflare Tunnel, also set `CLIENT_IP_HEADER=CF-Connecting-IP`. See [Reverse proxies and HTTPS](./reverse-proxy.md#what-trust-proxy-does). |
| `SQUIRMY_DATA_DIR` | The data folder: artwork, transcodes, uploads in progress, and the generated server secret. In the image it is `/data`, the `squirmy_data` volume. Part of it cannot be rebuilt; see [Backup](./backup.md#what-is-in-the-data-folder). |
| `SQUIRMY_ROLE` | `all` (default) runs the API and the background worker in one process. `api` and `worker` split them; see [Splitting the API and the worker](#splitting-the-api-and-the-worker). |

## Environment variables

Every variable the server reads, from `apps/server/src/config.ts`. "Image" is the value the Docker image sets; Compose adds the ones marked "compose".

| Variable | Default | Description |
|---|---|---|
| `DATABASE_URL` | none, required | PostgreSQL connection string. Compose sets `postgres://squirmy:<POSTGRES_PASSWORD>@postgres:5432/squirmy`. PostgreSQL 15 or newer with the `pg_trgm` extension available; the migrations create the extension. |
| `PORT` | `4747` | Port the HTTP server listens on inside the container. Change the host side with `SQUIRMY_PORT` in `.env` instead. |
| `HOST` | `0.0.0.0` | Address to listen on. |
| `PUBLIC_URL` | unset (compose: `${PUBLIC_URL:-}`) | The public origin, for example `https://music.example.com`, without a trailing path. Must be a valid URL when set; empty means unset. An `https://` origin also marks the session cookie `Secure` for requests to its host name, and turns on [passkeys](./authentication.md#passkeys) for that host name. |
| `TRUST_PROXY` | `false` (compose: `${TRUST_PROXY:-false}`) | Which proxies may report the client's address and protocol in `X-Forwarded-For`, `X-Forwarded-Proto` and `X-Forwarded-Host`: `false`; `true` for one proxy connecting from this machine or a private network; a number of proxies, such as `2`; or a comma-separated list of addresses, CIDR ranges and `loopback`, `linklocal`, `uniquelocal`, `private`. An unknown value stops the server at start. Before this setting took these forms, `true` trusted every proxy and `1` meant the same as `true`; `1` now means one proxy from any address. See [What `TRUST_PROXY` does](./reverse-proxy.md#what-trust-proxy-does). |
| `CLIENT_IP_HEADER` | unset (compose: `${CLIENT_IP_HEADER:-}`) | A header the outermost proxy sets to the client's address, such as `CF-Connecting-IP` behind Cloudflare. Read only from a peer `TRUST_PROXY` trusts, and only when it holds one address. Setting it with `TRUST_PROXY=false` stops the server at start. |
| `SQUIRMY_DATA_DIR` | `./data` (image: `/data`) | The data folder. |
| `SQUIRMY_SECRET` | unset | The root secret for signing stream URLs and encrypting stored credentials, at least 16 characters. When unset, a random one is generated on first start and kept in `<data>/secret.key`. Do not set or change it on a server that already has data: everything encrypted under the old secret (app passwords, API keys, provider secrets, scrobbling connections) becomes unreadable. |
| `SQUIRMY_ROLE` | `all` | `all`, `api` or `worker`. |
| `SQUIRMY_LIBRARY_PATHS` | unset (compose: `/music`) | Comma-separated absolute paths. On every start, each one that is not already a library folder is added as a **read-only** folder, watched, and scanned. A path that does not exist or overlaps another folder is skipped with a warning in the log. Removing a path from this variable does not remove the folder from the library. |
| `SQUIRMY_MANAGED_LIBRARY_PATHS` | unset | The same, but each folder is added as a **managed** folder, which Squirmy may organize and file uploads into ([Organizing files](./organizing.md)). The folder must be writable by the server. A path in both variables is added as managed. Either variable only adds folders: a folder that is already in the library keeps the mode it has; change it in **Admin → Library**. |
| `SQUIRMY_INBOX_PATH` | unset | A folder watched for music to import, used while the `inboxPath` server setting is unset. See [Adding music](./adding-music.md#the-inbox-folder). |
| `SQUIRMY_WEB_DIST` | unset (image: `/app/apps/web/dist`) | The built web app to serve. Unset, the server serves only the API; the Vite dev server proxies to it during development. |
| `SQUIRMY_READ_CACHE_MB` | `64` | Memory the API process may use to keep recent answers for Home, the library lists and album, artist and playlist pages, per user. Changes drop the affected answers at once; anything else is recomputed after five minutes at most. `0` turns the cache off. |
| `SQUIRMY_DB_POOL_SIZE` | `10` | Database connections each Squirmy process keeps for queries, from 2 to 200. Background jobs keep 6 more of their own, and each process uses one more for locks. Raise it only for a big install where the API is slow while many jobs run, and keep the total for every process under PostgreSQL's `max_connections` (100 by default). |
| `LOG_LEVEL` | `info` | `fatal`, `error`, `warn`, `info`, `debug`, `trace` or `silent`. |
| `FFMPEG_PATH` | `ffmpeg` | The `ffmpeg` binary. Any build from FFmpeg 4 on works; files are opened with `-protocol_whitelist` and `-format_whitelist`, so only local files in audio formats are read. |
| `FFPROBE_PATH` | `ffprobe` | The `ffprobe` binary, opened with the same restrictions. |
| `FPCALC_PATH` | `fpcalc` | The `fpcalc` binary (Chromaprint), used for AcoustID fingerprints. It never opens a file itself: ffmpeg decodes the file and fpcalc reads the samples. |
| `NODE_ENV` | `development` (image: `production`) | Only when it is set to `development` explicitly does the API also accept cross-origin requests with credentials from the Vite dev server on port 5173. The dev server proxies the API, so `npm run dev` does not need it. |
| `SQUIRMY_VERSION` | unset (image: the build argument) | The version reported by `/api/v1/setup/status` (shown on the sign-in page and in Admin), to Subsonic apps and in the User-Agent sent to metadata services. Release images set it to the release number. Unset or empty, the server reports `dev+<commit>`: the first 7 characters of `SOURCE_COMMIT` when it is set, else the short commit of the git checkout it runs from (read once at start), and `dev` when there is neither, as in an image built without either argument. |
| `SOURCE_COMMIT` | unset (image: the build argument) | The commit a source build was built from, used for the `dev+<commit>` version above. Pass it with `--build-arg SOURCE_COMMIT=$(git rev-parse HEAD)`. Coolify sets it in the container on every deployment. Ignored unless it is 7 to 40 hexadecimal characters. |

`compose.yaml` itself reads these from `.env` or the shell:

| Variable | Default | Used for |
|---|---|---|
| `MUSIC_DIR` | `./music` | The host folder mounted at `/music`. |
| `POSTGRES_PASSWORD` | `squirmy` | The database password. It takes effect only when the database volume is first created. |
| `SQUIRMY_PORT` | `4747` | The host port. |
| `PUBLIC_URL` | unset | Passed through to the app. |
| `TRUST_PROXY` | `false` | Passed through to the app. |
| `PUBLIC_URL` | unset | Passed through to the app. Empty counts as unset. |
| `CLIENT_IP_HEADER` | unset | Passed through to the app. |

To set a variable that `compose.yaml` does not pass through, such as `LOG_LEVEL`, add it under `environment:` of the `app` service:

```yaml
services:
  app:
    environment:
      LOG_LEVEL: debug
```

## Server settings

Stored in the `server_settings` table, from `ServerSettings` in `packages/contracts/src/settings.ts`. Changes apply right away, with no restart. In the web app, each change saves as you make it; text fields save when you leave them or press Enter.

### Admin → Server settings

| Section | Setting (as on screen) | Key | Default | What it does |
|---|---|---|---|---|
| General | Server name | `serverName` | `Squirmy` | Shown on the web app's sign-in page and in the iOS app's connect and sign-in screens. |
| | Wantlist | `wantlistEnabled` | off | Turns on the [wantlist](../use/wantlist.md), a list of music the server does not have yet. Off, the apps show no trace of it and wants stay stored, so turning it back on brings them back. |
| Registration | Require an invite to join | `registrationRequiresInvite` | on | Off lets anyone who can reach the server create a member account. |
| Metadata sources | MusicBrainz | `musicBrainzEnabled` | on | Identifies albums and fills in discographies. Off means nothing new is identified. |
| | MusicBrainz server | `musicBrainzBaseUrl` | `https://musicbrainz.org` | Base URL of a MusicBrainz web service, a full `http://` or `https://` address. Only `musicbrainz.org` and its subdomains are rate limited, so a mirror lifts the limit. |
| | Cover Art Archive | `coverArtArchiveEnabled` | on | Album covers. |
| | Deezer | `deezerEnabled` | on | Catalog search, artist images, top songs and cover fallback. |
| | Wikidata and Wikipedia | `wikidataEnabled` | on | Artist images and biographies. |
| | LRCLIB | `lrclibEnabled` | on | Synced lyrics. |
| API keys | ListenBrainz | `listenBrainzToken` | not set | A ListenBrainz user token for top songs, similar artists and popularity. Users' own scrobbling does not need it. |
| | AcoustID | `acoustIdKey` | not set | Uses audio fingerprints when tags and search do not produce a confident match. |
| | fanart.tv | `fanartKey` | not set | Better artist images. |
| | Last.fm | `lastFmKey`, `lastFmSecret` | not set | Lets users connect Last.fm for scrobbling. |
| Matching | Accept matches automatically above | `matchAutoAcceptScore` | 90% | Matches at or above this score are applied; lower ones (down to 50%) wait in the review queue. |
| Library | Keep missing files for | `missingFileGraceDays` | 14 days | How long a vanished file stays in the library before it is removed. 0 to 365. |
| Imports | Import into | `importRootId` | not chosen | The managed library folder uploads and inbox imports are filed into. Not chosen means the only enabled managed folder, when there is exactly one. |
| | Inbox folder | `inboxPath` | not set | The [inbox](./adding-music.md#the-inbox-folder). Empty falls back to `SQUIRMY_INBOX_PATH`. It must be a folder of its own: not `/`, a home folder or a system folder (`/etc`, `/usr`, `/var` and the folders directly in it, and so on), and not inside a library folder or the data folder; the screen says why a folder is refused. |
| | Largest file | `importMaxFileBytes` | 4 GB | Largest single file an import accepts, zip archives included. |
| | Largest import | `importMaxBytes` | 64 GB | Largest import, counting what its archives extract to. |
| | Uploads at once | `importMaxActivePerUser` | 3 | Uploads one member may have receiving or processing at once. Admins are not limited. API only for now. |
| Transcoding | Transcode cache | `transcodeCacheMaxBytes` | 10 GB | Converted streams kept on disk; the least recently used go first. |

Turning a metadata source off stops new requests to it; what it already provided stays. API keys are stored encrypted and are never shown again: the screen says **Set** or **Not set**, with **Change** or **Add key**, and **Remove key** in the dialog.

### Through the API

Every setting can also be set with `PATCH /api/v1/admin/settings` by an admin. Sign in to get a token first:

```sh
TOKEN=$(curl -s -X POST https://music.example.com/api/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"your password"}' | jq -r .token)
```

Then send only the keys you change:

```sh
curl -X PATCH https://music.example.com/api/v1/admin/settings \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"inboxPath": "/inbox", "importMaxFileBytes": 8589934592}'
```

Sizes are in bytes, and `importRootId` takes a folder id from `GET /api/v1/admin/library/roots`.

`GET /api/v1/admin/settings` returns every setting; secrets come back only as `listenBrainzTokenSet`, `acoustIdKeySet`, `fanartKeySet` and `lastFmKeySet`. A secret set to `null` or `""` is removed.

Acquisition has its own policy settings; see [Acquisition providers](./acquisition.md#policy).

### Per-user settings

Each user has their own, in **Settings** in the web app and in the iOS app's account sheet: volume normalization (default Automatic), streaming quality on Wi-Fi (default Original) and on cellular (default High), scrobbling switches, and for the iOS app's downloads, the download quality (default Original) and Wi-Fi only (default on). The iOS storage limit for downloads is kept on the phone, not on the server. See [Playback](./playback.md).

## Splitting the API and the worker

By default one process serves HTTP and runs the background jobs (scans, identification, enrichment, loudness, imports). On a busy server you can run them separately:

- Run **exactly one** `api` process. Playback sessions are held in that process's memory, so two API processes would disagree about what is playing.
- Run one or more `worker` processes. A worker opens no HTTP port. File watching and the inbox run in workers.
- Every process needs the **same** `DATABASE_URL`, the **same data folder** (artwork written by the worker is served by the API; uploads land in the API's staging folder and are processed by a worker), the **same music paths**, the **same secret** (a shared data folder gives them the same `secret.key`, or set `SQUIRMY_SECRET` on all of them), and the **same `PUBLIC_URL`**: a worker builds the delivery addresses handed to [acquisition providers](./acquisition.md), and without it they would point at `http://localhost:4747`, the worker itself.

A Compose sketch, added to the existing `compose.yaml`:

```yaml
services:
  app:
    environment:
      SQUIRMY_ROLE: api

  worker:
    image: ghcr.io/isaacthoman/squirmy:latest
    build: .
    restart: unless-stopped
    depends_on:
      postgres:
        condition: service_healthy
    environment:
      DATABASE_URL: postgres://squirmy:${POSTGRES_PASSWORD:-squirmy}@postgres:5432/squirmy
      SQUIRMY_ROLE: worker
      PUBLIC_URL: ${PUBLIC_URL:-}
    volumes:
      # The same mount as the app's.
      - type: bind
        source: ${MUSIC_DIR:-./music}
        target: /music
        bind:
          create_host_path: true
      - squirmy_data:/data
    # As for the app: time for long jobs to record where they got to before a SIGKILL.
    stop_grace_period: 30s
    # The image's health check calls /ready, which a worker does not serve.
    healthcheck:
      disable: true
```

Leave `SQUIRMY_LIBRARY_PATHS` and `SQUIRMY_MANAGED_LIBRARY_PATHS` on the `app` service: any process adds the configured folders on start, so one is enough.

## Scheduled work

These run on their own; nothing needs configuring. Times are UTC.

| Job | When |
|---|---|
| Full scan of every enabled folder | daily at 04:00 |
| Check for lost artwork files and rebuild them | daily at 04:40 |
| Merge an artist's duplicate album rows (one release listed twice), and give popular songs without one their album and cover | daily at 04:50, and when the server starts |
| Remove files missing longer than the grace period | daily at 05:30 |
| Remove search results nobody kept (catalog stubs older than 30 days) | daily at 05:45 |
| New releases from the artists in each user's library | Mondays at 06:00 |
| Retry identification of albums still waiting | every 10 minutes |
| Measure loudness of files that have none | every 10 minutes |
| [Analyse](./sonic-analysis.md) files not analysed yet, and read their tempo, key and mood tags | every 10 minutes |
| Fill in covers, images and lyrics still missing | every 30 minutes |
| Trim the transcode cache to its size | hourly |
| Trim the [fetched-music cache](./acquisition.md#the-cache) to its limit | hourly at :17 |
| Clean up stale imports | every 15 minutes |
| Send scrobbles; check acquisition jobs | every minute |
| Resume a [search index import](../local-search-index.md#restarts) a restart or crash stopped | every minute, and when the server starts |
| Ask enabled [providers](./acquisition.md#tracks-a-provider-could-not-supply) for their capabilities, noticing new versions | every 5 minutes |

The **Jobs** page in **Admin** shows every queue with its queued, active and failed counts.
