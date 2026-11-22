# Troubleshooting

Each problem below says how to confirm it and how to fix it. Start with the logs and the Jobs page; most answers are in one of them.

## Logs and the Jobs page

**Logs.** The server logs to standard output:

```sh
docker compose logs -f app
```

HTTP requests and errors are JSON lines; the library, watchers and imports add plain lines such as `Not watching /music: it is a network mount.`. For more detail, set `LOG_LEVEL: debug` under the `app` service's `environment:` in `compose.yaml` and run `docker compose up -d`. Valid levels are `fatal`, `error`, `warn`, `info` (default), `debug`, `trace` and `silent`.

Request lines show the URL with the values of credential parameters replaced by `[redacted]`: Subsonic `p`, `t`, `s` and `apiKey`, stream signatures (`sig`) and Last.fm's `token` and `state`. Logs kept from earlier versions may hold them in clear: treat those logs as secret, or delete them and have users replace their app passwords if the logs were shared.

**Jobs.** **Admin → Jobs** lists every background queue with its **Queued**, **Active** and **Failed** counts, refreshed every few seconds. The names say what they do:

| Queue | Work |
|---|---|
| `library.scan`, `library.probe`, `library.ingest`, `library.analyze` | Finding files, reading tags, building albums, hashing audio |
| `matching.match-album` | Identifying albums against MusicBrainz |
| `enrichment.album`, `enrichment.artist`, `enrichment.lyrics` | Covers, images, bios, lyrics |
| `loudness.measure`, `loudness.album` | Loudness for normalization |
| `streaming.evict` | Trimming the transcode cache |
| `imports.process` | Uploads and the inbox |
| `acquisition.*` | Fetching through providers |
| `scrobble.deliver` | Sending plays |
| `organize.apply`, `organize.revert` | Moving and retagging files into a managed folder, and undoing it |
| `artwork.recover` | Rebuilding lost image files |
| `catalog-index.import` | Building the local search index |
| `library.scan-after` | A full scan waiting for a scan of a few folders to finish |
| `*.sweep`, `library.scan-all`, `library.purge-missing`, `search.cleanup`, `enrichment.new-releases`, `enrichment.reconcile`, `matching.retry-fingerprints` | Scheduled and follow-up work; see [Scheduled work](./configuration.md#scheduled-work) |

A large **Queued** count on `matching.match-album` right after a first scan is normal: see [identification is slow](#identification-is-slow). A growing **Failed** count is not; the log has the error.

**Health.** `curl http://localhost:4747/health` answers as soon as the process runs; `curl http://localhost:4747/ready` also checks the database and answers 503 when it cannot reach it. The container's health check uses `/ready`, so `docker compose ps` shows `(healthy)` once migrations have run and the database answers, and `(unhealthy)` after about a minute of failures. `docker inspect <container>` shows the last checks under `State.Health`.

**Which build is running.** `curl http://localhost:4747/api/v1/setup/status` reports `version`: the release number for a release image, `dev+<commit>` for a source build that knows its commit (from `SOURCE_COMMIT` or git), and `dev` for one that does not.

## The server does not start

Confirm with `docker compose ps` and `docker compose logs app`.

- **`DATABASE_URL is required`**, or a connection error: the `postgres` service is not healthy or the URL is wrong. `docker compose logs postgres` tells you which.
- **Password authentication failed** after changing `POSTGRES_PASSWORD`: the password only applies when the database volume is first created. Put the old one back, or change it inside the database with `ALTER USER squirmy PASSWORD '…'`.
- **`[squirmy] failed to start`** followed by a migration error: restore the dump you took before upgrading (see [Backup](./backup.md#upgrading)) and report the error.
- **A `PUBLIC_URL` error**: it must be a full URL such as `https://music.example.com`, or empty or not set at all.

## Nothing appears after adding a folder

Confirm in **Admin → Library**: the folder's card shows its file count, "not scanned yet" or when it was scanned, and how many files were unreadable.

- **The folder is not inside the container.** The folder picker browses the container's file system, not the host's. Check with `docker compose exec app ls /music`. Add the folder as a volume in `compose.yaml` and choose its path inside the container.
- **The server cannot read it.** Adding fails with "The server cannot read that folder", or the scan finds 0 files. The container runs as uid 1000; give that user read access (and write access for a managed folder): `ls -ln` on the host shows the owner.
- **A configured folder was skipped.** The log says `Not adding … from SQUIRMY_LIBRARY_PATHS: …` (or `SQUIRMY_MANAGED_LIBRARY_PATHS`) with the reason (the path does not exist, or it overlaps another folder).
- **New files in an existing folder do not show up.** The folder may not be watched: network mounts and Docker Desktop bind mounts often deliver no change events. Choose **Scan now**, or wait for the nightly scan. See [When watching does not work](./library.md#when-watching-does-not-work).
- **Unreadable files** are files no tag reader could parse; they are left alone until they change.

## Albums stay unidentified

Confirm in **Admin → Library** under **Identification**: **Waiting** means not tried yet; **From tags only** means tried and not identified; **In review** means an admin has to choose.

- **Waiting for a long time**: identification is slow on a big library, not stuck. See below.
- **From tags only, everywhere**: check that **MusicBrainz** is on in **Admin → Server settings**, and that the server can reach the internet: this prints `200`:

  ```sh
  docker compose exec app node -e "fetch('https://musicbrainz.org/ws/2/artist?query=test&fmt=json', { headers: { 'User-Agent': 'Squirmy-check ( https://github.com/IsaacThoman/squirmy )' } }).then(r => console.log(r.status))"
  ```

  MusicBrainz answers 403 to requests without a User-Agent, so keep the header. A `503` means it is limiting requests from your address right now (the server may be using its share); try again a few seconds later.
- **From tags only, some albums**: the tags may lack an album artist and album title, or be too far from the release MusicBrainz knows. Use **Fix match** (see [The review queue and Fix match](./library.md#the-review-queue-and-fix-match)). Files with no album and artist tags at all can be identified by fingerprint once an AcoustID key is added.
- **In review**: open **Admin → Review queue**. If too many good matches end up there, lower **Accept matches automatically above** a little.

## No covers

- **Unidentified albums** have no MusicBrainz id, so their cover can only come from the files: a picture embedded in the tags, or an image in the album's folder named `cover`, `front`, `folder`, `album` or `albumart…`.
- **Identified albums** get covers in the background, every 30 minutes for albums still missing one. Check that **Cover Art Archive** (and **Deezer**, the fallback) are on in **Admin → Server settings**, and that the server can reach the internet.
- **Albums you do not own** (new releases, an artist's discography) show the Cover Art Archive's cover, downloaded the first time someone looks at it. For a release from the last few days the archive may have only the full-size original yet, which is then downloaded instead. When the archive has no cover at all, the album takes its Deezer cover, or a picture from its files, if either exists; otherwise it shows none.
- **Covers that used to work and now do not**: the data folder's `assets/` may have been deleted or not restored. Most images are rebuilt from the music files, folder images and the URLs they came from on their own, some only after a background download, so reload after a minute. Images whose source has changed are not; restore `assets/` from a backup for those ([When `assets/` is lost](./backup.md#when-assets-is-lost)).

## The app cannot connect

The iOS app explains what failed:

- **"Couldn't reach …"**: the phone cannot reach the address. From the phone's network, `localhost` and `127.0.0.1` are the phone itself; use the server's LAN address (`http://192.168.1.20:4747`) or its public name. Check the firewall and `SQUIRMY_PORT`. If you denied Local Network access, turn it on in iOS **Settings → Privacy & Security → Local Network**.
- **"… answered with an error"**: the server is up but failing; check its log. Behind a proxy, the proxy may not reach the server.
- **"… doesn't look like a Squirmy server"**: the address answers, but it is something else, often a proxy's default page. Check the host name in the proxy configuration.
- **"… isn't set up yet"**: create the admin account in a browser first.

For an HTTPS address, the certificate must be valid and trusted by the phone; a self-signed certificate is refused.

The web app shows "Reconnecting to the server…" when its live connection is down for more than three seconds. Behind a proxy that almost always means WebSocket upgrades on `/socket.io` are not passed through. See [Reverse proxies](./reverse-proxy.md).

## Playback stalls or does not start behind a proxy

- **Starts late, especially for converted streams**: the proxy is buffering responses. Turn buffering off (`proxy_buffering off` in nginx, `flush_interval -1` in Caddy).
- **Seeking restarts the track or does not work**: the proxy strips the `Range` header or rewrites `206` responses. Pass them through unchanged.
- **Other devices do not follow, or "Reconnecting…" stays**: WebSockets are not reaching `/socket.io`.
- **Plays in the browser after a click only**: browsers block audio until you interact with the page; use **Enable audio** in the notice.

Test the stream path from outside with `curl -I https://music.example.com/health`, then play a track with the browser's network panel open: the stream request should answer `206 Partial Content`.

## Uploads fail on size

- **413 from the proxy** (an HTML error page, often nginx's; the web app says the upload was refused "before it reached Squirmy"): the proxy's body size limit. Set `client_max_body_size 0;` in nginx, or the equivalent; see [Reverse proxies](./reverse-proxy.md).
- **413 from Squirmy** (JSON with `file_too_large` or `import_too_large`): the file or the whole import is over `importMaxFileBytes` (4 GiB) or `importMaxBytes` (64 GiB). Raise them in **Admin → Server settings → Imports** ([Configuration](./configuration.md#server-settings)).
- **507 `insufficient_storage`**: the upload (or a zip in it) would leave the server's staging disk with less than 1 GiB free. Free some space, or move `SQUIRMY_DATA_DIR` to a bigger disk.
- **429 `too_many_imports`**: a member already has `importMaxActivePerUser` (3) uploads receiving or processing. Let one finish, or cancel an unfinished one under **Add music**.
- **Large uploads cut off after a minute behind Traefik**: Traefik v3's 60 second read timeout. Set `respondingTimeouts.readTimeout=0` on the entry point.
- **`no_managed_root` or `import_root_not_set`**: imports need a managed folder to file into. See [Adding music](./adding-music.md#before-you-start-a-managed-folder-to-file-into).

## Identification is slow

This is expected. The public MusicBrainz server allows one request per second, and an album needs several. A library of 1,000 albums takes a few hours; 10,000 takes more than a day. Music stays playable from its tags meanwhile, and the work resumes after restarts.

Confirm on **Admin → Jobs**: `matching.match-album` has a long **Queued** list and one or two **Active**, and the **Identified** percentage in **Admin → Library** keeps rising. The only way to make it fast is your own MusicBrainz mirror ([details](./metadata-and-privacy.md#the-musicbrainz-rate-limit)).

## An artist page lists a release twice, or a song as an album

The same release can reach the server from several places: search results from Deezer, the artist's discography from MusicBrainz, the album a popular song belongs to, the tags of a fetched file. The server merges such rows into one, keeping likes, plays, playlists and library saves, when the artist's page is filled in, when search finds new albums for the artist, daily at 04:50 and when the server starts. Until then the artist page already shows each release once. Two releases that only share a title stay apart: an album and its title-track single, a remix album ("Miss Anthropocene (Rave Edition)"), or a demo. Editions stay apart too, so a deluxe edition you open keeps its songs ("SOS Deluxe: LANA", "Midnights (3am Edition)"); the artist page lists the release once. Collaborations led by someone else are listed under **Appears on**.

## The first open of an artist page is slow

Opening an artist or album the server knows little about fetches its details on the spot: discography, images, biography, top songs. The page waits at most four seconds and then shows what it has; the rest fills in the next time. The second visit is fast.
