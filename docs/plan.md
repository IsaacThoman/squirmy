# Squirmy product plan

Squirmy is a self-hosted music server, a web app, and an iOS app. Other people run their own copies.

- Your files are identified and organized by the server.
- Search covers all music, and anything you don't have shows gray.
- Each user has one live playback session shared across their devices.
- Existing Subsonic clients work against it.

The technical conventions that implement this plan live in [architecture.md](./architecture.md). Progress is tracked in [roadmap.md](./roadmap.md).

## Design rules

- **Files are the source of truth for audio.** Postgres holds everything else, and all of it except user data can be rebuilt.
- **MusicBrainz IDs identify everything.** Every other service is optional, cached and replaceable.
- **Music plays even when identification fails.**
- **User data points at catalog entries, not files.** Likes, playlists and history survive re-rips and retagging.
- **The repository bundles no content sources.** Acquisition providers are a generic interface and the repo names none.

## Stack and repo

```
apps/mobile            Expo app (iOS first)
apps/web               Vite, React, Tailwind, Radix, TanStack Query
apps/server            Fastify, Drizzle, Postgres, pg-boss, socket.io
packages/contracts     zod schemas shared by all three
packages/client-core   session reducer, API client, formatters
docs/                  plan, architecture, self-hosting guide, provider protocol
```

- **Server libraries:** `music-metadata` (tags), `sharp` (artwork), ffmpeg (transcoding, loudness, audio hash), `fpcalc` (fingerprints), argon2.
- **Left out:** Redis and object storage. Jobs run on Postgres through pg-boss.
- **Conventions:** conventional commits, semantic-release on `main`, oxlint, vitest, migrations on boot.
- **Licence:** GPL-3.0-or-later.

## Data model

```
Catalog    artists, albums (release groups), releases (editions),
           recordings, release_tracks, external_ids, assets, lyrics

Library    library_roots (path, mode: read-only | managed)
           media_files (path, audio_hash, format, tags, loudness, peak,
                        recording_id, match_status, confidence, source)
           file_moves (undo journal), transcodes (cache index)

Users      users, auth_sessions, app_passwords, invites, devices
           playback_sessions (state JSON, version)
           likes, playlists, playlist_items, plays, wants

Providers  acquisition_providers, acquisition_jobs
```

- **The catalog is a lazy cache.** It holds everything you own plus whatever anyone has browsed, each row with a fetch time for refresh.
- **Ownership is derived.** A recording is owned when a present file links to it; album availability follows from that.
- **Availability on every track and album:** `none`, `on_demand` or `server` for tracks; albums add `partial` and `full`. Clients overlay "on device" themselves.
- **Local-only rows.** Unidentified music gets catalog rows with no MusicBrainz ID, built from file tags.
- **Merges.** When a local-only album is matched later, or MusicBrainz merges two IDs, one transaction re-points files and user data and leaves a redirect.
- **Missing files get a grace period.** An unmounted drive marks files missing rather than emptying the library.

## Metadata sources

| Source | Role | Default |
|---|---|---|
| MusicBrainz | IDs, discographies, track lists | On |
| Cover Art Archive | Album covers | On |
| Deezer | Fast typeahead, artist images, cover fallback, top tracks | On |
| Wikidata and Wikipedia | Artist images and bios, via MusicBrainz links | On |
| LRCLIB | Synced lyrics | On |
| ListenBrainz | Top tracks, similar artists; scrobbling with each user's own token | Server lookups on once a token is set; scrobbling once a user connects |
| AcoustID | Fingerprint lookup | On once an API key is set |
| fanart.tv | Better artist images | Off; needs an operator key |
| Local search index | Typeahead from MusicBrainz canonical dumps | Optional |

Every source can be switched off in admin settings. The MusicBrainz client uses one queue at 1 request/second, an identifying User-Agent, and a response cache in Postgres. Its base URL is configurable, so an operator with their own mirror has no rate limit.

## Library pipeline

```
discover → probe → group → match → enrich → measure loudness
```

- **Discover.** File watching where it works, scheduled full scans, and a "Scan now" button.
- **Probe.** Tags, technical details, and a hash of the audio stream computed without decoding. Retagging or moving a file does not change its identity.
- **Group.** By folder, album tag and album artist.
- **Match, album-first, in tiers:**
  1. MusicBrainz IDs already in the tags.
  2. Artist, album and track count, scored on titles and durations.
  3. AcoustID fingerprint for untagged files.
  4. Below the threshold, a review queue with "Fix match".
- **Manual matches are locked.** A rescan never overwrites them.
- **Enrich.** Covers (Cover Art Archive, then embedded art, then folder images, then Deezer), artist images, bios, lyrics (embedded, `.lrc` sidecar, then LRCLIB). `sharp` resizes images and produces the album color and a blur placeholder.
- **Every stage is a resumable job.** Heavy ones run at low priority.

Music is playable from its tags the whole time identification runs, and the admin page shows progress.

## Managed roots

Each library root is read-only or managed. In a managed root the server renames and files music after it is identified.

- **Default template:** `Album Artist/Album (Year)/01 Title.ext`, with a disc prefix for multi-disc sets and filename sanitizing for every OS.
- **Preview first.** Show every proposed move; apply per album or all at once.
- **Journal and undo.** Every move is recorded and reversible.
- **Confident or approved matches only.** Everything else stays put.
- **Safe moves.** Rename within a filesystem; copy, verify, then delete across filesystems. Covers, `.lrc` and `.cue` files travel with the album.
- **Tag writing is a separate toggle.** Write to a copy, re-read it, confirm the audio hash is unchanged, then replace the original.

## Streaming and loudness

- **Signed, short-lived URLs with HTTP Range**, so `<audio>` and AVPlayer need no headers.
- **Original file by default.** When a recording has several files, the server picks the best one the client can play.
- **Transcode profiles:** AAC 256k, Opus 128k, and MP3 for older Subsonic clients. ffmpeg writes into a size-capped disk cache.
- **Loudness.** Read ReplayGain tags when present; otherwise measure with ffmpeg's `ebur128` filter per track and per album.
- **Normalization is applied on the client.** Modes: off, track, album, auto. Web uses a Web Audio gain stage; mobile attenuates only.

## Playback sessions

- **One session per user, held by the server:** queue, current track, shuffle and repeat, position anchor, active device.
- **One active device plays; every other client is a remote.** Opening the web app while the phone plays shows the same Now Playing with a "play here" action.
- **Commands go through the server.** It runs the shared reducer, bumps a version and broadcasts. Clients apply commands optimistically and reconcile.
- **The active device follows the session and reports back:** track ends, stalls, drift. Plays are recorded from those reports.
- **Position is computed, not streamed.** Clients estimate the server clock offset and derive position from the anchor.
- **The active device advances by itself.** It holds the next few tracks, so gapless, background and brief disconnects work.
- **Reconnect rule.** A returning device's state wins only if no other device took over.
- **Queue and state are versioned separately,** so a long queue is not resent on every pause.
- **The same socket carries invalidations** for likes, playlists and scan progress.

A device is listed only while its socket is connected, so a paused phone that iOS has suspended drops off until reopened.

## Search and browsing

- **Two queries in parallel.** Your library comes from Postgres trigram search, instantly and at full brightness. The catalog comes from a search provider, grayed and deduplicated against library hits.
- **Search providers are pluggable.** Deezer is the default; MusicBrainz is the fallback when Deezer is off; the local index is optional.
- **Opening a catalog result resolves it to MusicBrainz** by link, barcode, ISRC, or name, then caches it.
- **Artist pages:** image, bio, top tracks, and the full discography with owned albums lit.
- **Album pages:** track list with per-track availability.
- **Wantlist.** Gray items can be wanted; a matching import completes them. Off unless the admin turns it on (`wantlistEnabled`): with a provider that can fetch anything it is noise.
- **Home:** recently added, recently played, new releases from artists you own, and the wantlist when it is on.

## OpenSubsonic

- **A second router at `/rest`** over the same services. First-party apps keep the native API.
- **Owned music only.** Gray items never appear, and playlists skip unowned tracks.
- **Separate credentials.** Classic Subsonic auth needs a recoverable password, so users generate revocable app passwords, stored encrypted. The `apiKey` extension is supported too.
- **XML and JSON responses,** plus synthesized folder browsing for older clients.
- **Mappings:** star ↔ likes, scrobble ↔ plays, `replayGain`, `musicBrainzId` and `isrc` on songs, lyrics by song ID, play queue ↔ session queue.

## Acquisition providers

Off by default. This is a generic interface for a service that can supply missing music; the repo names no sources and ships only clean adapters.

- **Separate services,** registered by URL and shared secret. No third-party code loads into the server.
- **Three calls:** `capabilities`, `resolve` (returns offers with format and quality), `acquire` (starts a job).
- **Delivery reuses the import endpoint,** so files go through the normal identify-and-file pipeline.
- **Verify before linking.** Check identifiers, title, artist and duration against the request. A mismatch is never linked to it: the file stays in the library as what it is, marked with the provider it came from, and the request fails.
- **Playback.** An `on_demand` track enters `preparing`, and the socket announces when it is ready. The server prefetches the next queue entries.
- **Policy on the server:** who may trigger fetches, preferred formats, storage quota, audit log.
- **Reference adapters:** cold storage and a mock.

Purchasing (priced offers, caps, budgets) is deferred. The protocol reserves an optional `price` field, and the server ignores priced offers until that work lands.

## Clients

**Mobile**

- Connect and login screens, with the token in SecureStore.
- TanStack Query with a persisted cache; artwork is a URL plus color and placeholder.
- A player engine wraps `expo-audio`, follows the session, and drives lock-screen controls.
- A real devices sheet.
- Offline downloads: files through `expo-file-system`, an index in `expo-sqlite`, and a Wi-Fi-only option.
- Android keeps compiling through the existing fallbacks but is not a focus. Subsonic clients cover it.

**Web**

- Layout: a sidebar that folds to icons and is a drawer on phones, the main view, a player bar along the bottom, a queue panel beside the page.
- Search: a search page, and a quick search dialog from any page.
- Settings in a dialog. Appearance is light, dark or the system's, with a choice of color themes, kept per browser.
- Audio: `HTMLAudioElement`, the Media Session API, and Web Audio gain.
- Admin: setup wizard, library roots, job status, review queue, organize preview, users and invites, providers.
- Upload by dragging in a folder or zip.

## Accounts and security

- First run creates the admin; others join by invite. Roles are admin and member, with flags for uploading and for triggering acquisition.
- The library is shared. Likes, playlists, history and the session are per user.
- argon2 passwords and opaque session tokens stored hashed. Cookie on web, bearer token on mobile, the same token on the socket.
- Login rate limiting and CSRF protection.
- Provider secrets and app passwords are encrypted at rest.

## Packaging

- Two containers: `postgres`, and one `app` image with API, worker, built web, ffmpeg and `fpcalc`, for amd64 and arm64. An env var splits API and worker for bigger installs.
- Two volumes: the music, and a data folder for artwork, transcodes, staging and the generated secret. Transcodes and resized artwork rebuild themselves, and original artwork is rebuilt from the files and URLs it came from when it can be; the secret is not.
- Backup is a database dump, the music, and the data folder's `secret.key` and `assets/` ([backup guide](./server/backup.md)).

## Milestones

1. **Foundations.** Monorepo, contracts, shared reducer, CI, release tooling.
2. **Your files, playing.** Server, auth, setup wizard, scan, tags-only library, streaming, server-held session, loudness, real audio on phone and web.
3. **Connect.** Device list, transfer, remote control, reconnect rule, live invalidations.
4. **Identify and reorganize.** MusicBrainz matching, review queue, enrichment, merges, then managed roots with preview, undo and tag writing.
5. **OpenSubsonic.** Router, app passwords, transcoding, client test pass.
6. **Search everything.** Local search, search providers, gray-out, artist and album pages, wantlist.
7. **Add and take.** Web upload, inbox folder, fingerprinting, offline downloads.
8. **Providers and extras.** Acquisition protocol and reference adapters, external scrobbling, radio from similar-artist data, local search index, docs site.
