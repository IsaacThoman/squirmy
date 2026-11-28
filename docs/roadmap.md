# Roadmap

Status of the milestones in [plan.md](./plan.md). Update this file in the pull request that changes a status.

## 1. Foundations

- [x] Monorepo: `apps/mobile`, `apps/server`, `packages/contracts`, `packages/client-core`
- [x] Contracts for auth, catalog, playback, sessions, search, user data, settings, library
- Search supports composite catalog queries, fuzzy non-Latin names, visible playlist names, stored lyric excerpts and composer or producer credits. The web results can filter by file quality, release decade and likes.
- [x] Database schema for every milestone, initial migration, test harness
- [x] CI: lint, typecheck, build, tests against Postgres
- [x] semantic-release on `main`
- [x] Shared session reducer and session client in `client-core`
- [x] Docker image and `compose.yaml`

## 2. Your files, playing

- [x] Server core: auth, users, invites, settings, jobs, realtime transport
- [x] Library scan, tag reading, local-only catalog rows
- [x] Recording credits, classical works and file advisories in the catalog and web app
- [x] Artwork store and renditions
- [x] Library and catalog read API, home
- [x] Streaming: playback descriptor, signed URLs, Range, transcode cache
- [x] Loudness measurement and normalization values
- [x] Likes, ratings, playlists, history, user settings
- [x] Lyrics: embedded, sidecar and LRCLIB, shown on web and iOS, word by word from Enhanced LRC and TTML
- [x] Web app: setup, login, library, album and artist pages, player, queue
- [x] Web app on a desktop: multi-select in song lists and the queue, dragging songs and cards to playlists, the queue and the player, right-click menus on cards and the player, a command palette, keyboard shortcuts, a pop-out player
- [x] Now Playing's turning cover colors (web and iPhone), covers that crossfade, a lean-back full screen on the web and a Compact density
- [x] Mobile app: connect, login, real data, real audio, lock-screen controls

## 3. Connect

- [x] Server-held session with command log and versions
- [x] Device list, transfer, remote control
- [x] Reconnect rule and device-lost handling
- [x] Device presence: only devices that are open and answering the heartbeat are listed
- [x] Live invalidations on web and mobile
- [x] Signal path: each device reports what it plays; Lossless badge and Track info on web, iOS and Apple TV
- [x] Sleep timer held by the session: set anywhere, enforced by the server, faded out on the device that plays
- [x] Queue changes as small diffs against a queue version, with the whole queue as a checkpoint
- [x] Listen together: a host's session that other users' sessions follow, each playing on their own device in step, with invites, a shared queue and per-listener plays (web and iOS)

## 4. Identify and reorganize

- [x] Metadata clients with cache and rate limits
- [x] Album matching tiers, review queue, fix match, merges
- [x] Enrichment: covers, artist images, bios, lyrics, external ids
- [x] Managed roots: preview, apply, journal, undo (server and API)
- [x] Admin screens (web): library folders, review queue, Fix match, Organize, users and invites, server settings, jobs
- [x] Tag writing with verification
- [x] Admin tag editor, duplicate and bitrate review, and scheduled file health checks

## 5. OpenSubsonic

- [x] `/rest` router with XML and JSON ([subsonic.md](./server/subsonic.md))
- [x] App passwords and API keys
- [x] Browsing, search, streaming, cover art, stars, playlists, scrobble, play queue, lyrics
- [x] Enhanced lyrics, playback timelines, negotiated transcoding, sonic similarity and BPM and mood metadata
- [x] Client test pass: py-opensonic, py-sonic, subsonic-api (Node) and Airsonic Refix

## 6. Search everything

- [x] Library search
- [x] Deezer and MusicBrainz search providers, stub rows, stub cleanup
- [x] Resolve stubs on open (enrichment)
- [x] Artist and album pages for music you do not own
- [x] Similar artists on artist pages, genre pages
- [x] New-release feed on Home (server, web and iOS)
- [x] Wantlist (server, iOS add, web), opt-in behind `wantlistEnabled`
- [x] Wantlist: hidden on the web while `wantlistEnabled` is off, the switch in Admin → Server settings, and removing a want on iOS
- [x] Gray-out on web
- [x] Gray-out on mobile
- [x] One heart: hearting a song, album or artist is what saves it to the library, on web, iOS and Subsonic (stars); the web Library is one combined view like the phone's
- [x] iOS as a streaming app: one playable rule from client-core, one merged search list, a fetch shown as buffering ("Still loading…" after 8 s), what playback has to say (a failed song, an outage) in the player's status line rather than a toast, and a library that only the heart changes

## 7. Add and take

- [x] Imports: upload API, inbox folder, staging, zip extraction, duplicates, filing into a managed root (server)
- [x] Upload screen in the web app: folders, files and zips with progress, pause and cancel; the imports list and detail; import settings
- [x] A personal library: the library is what you heart (uploads hearted for their uploader), the server's music on Home and On this server, an opt-in to include all of it; Your uploads and Admin → Uploads to delete uploaded music (web; iOS next)
- [x] Fingerprinting for untagged files
- [x] Offline downloads on mobile, with their lyrics, and search over what the phone holds while offline
- [x] Several accounts on one phone or Apple TV: a switcher, and each account's downloads, streaming cache and saved library kept on the device for switching back

## 8. Providers and extras

- [x] Acquisition provider protocol, on-demand playback, policy ([provider-protocol.md](./provider-protocol.md)), and on the web the Providers admin screen, "Get this album" and preparing tracks
- [x] Reference adapters: cold storage and mock (`adapters/`)
- [x] A song the provider doesn't have is skipped with a light notice and playback goes on; only an outage, or nothing left that is available, stops it (server, web and iOS)
- [x] Gray out songs a provider lacks before they are played: resolve ahead of the queue and on album pages for `assume_available` providers
- [x] Replay listening statistics, Year in Review and listening history import and export (web)
- [x] Scrobbling to ListenBrainz and Last.fm, compatible ListenBrainz destinations and optional two-way heart sync
- [x] Webhooks, MQTT with Home Assistant discovery and scoped native API tokens
- [x] Radio and autoplay (server, API, web and iOS, and Subsonic similar songs)
- [x] A personal Home: Jump back in, daily mixes (Made for you) with their own page, Because you listened to, Your top artists, Rediscover, ordered by the time of day (server, web, iOS and Apple TV; iOS and tvOS not yet checked on a device)
- [x] Sonic analysis: tempo, key, energy, danceability, intro and outro, and timbre vectors from Squirmy's own DSP; tempo, key and mood tags; Deezer's tempo as a fallback. Radio ranks with it, and the web app has **Songs that sound like this** ([sonic-analysis.md](./server/sonic-analysis.md))
- [ ] Sonic radio on iOS and Apple TV, tempo and key in the song info
- [ ] Mixes and DJ-style transitions from the sonic analysis (the `artistSoundAffinity` seam and the hooks in [Sonic analysis](./architecture.md#sonic-analysis))
- [x] Detached playback: web and iOS devices can play their own queue and rejoin the shared session later ([detached-playback-ui.md](./detached-playback-ui.md))
- [x] Local search index: importer, search and admin routes ([local-search-index.md](./local-search-index.md)), offered as the first search provider, and its admin screen
- [x] Smart playlists: rules evaluated live on the server, a rule editor on the web, read-only in Subsonic and the iOS and Apple TV apps ([web.md](./use/web.md#smart-playlists))
- [x] Collaborative playlists with edit or add-only access, personal folders, custom artwork, file import and export, and duplicate removal ([web.md](./use/web.md#organizing-and-sharing-playlists), [ios.md](./use/ios.md#using-it), [subsonic.md](./server/subsonic.md#how-it-maps-onto-squirmy))
- [ ] Edit smart playlist rules in the iOS app
- [x] Documentation site ([docs/](./index.md), built with VitePress)
- [x] Docker health check on `/ready`, and the image reports its source version
- [x] Sessions list and sign-out, TOTP two-factor with recovery codes (server, web, iOS and Apple TV sign-in) ([authentication.md](./server/authentication.md))
- [x] Passkeys on the web: add, rename, remove, and username-less sign-in
- [x] OpenID Connect single sign-on (server, web, admin settings, iOS sign-in), linking accounts, and turning password sign-in off
- [x] Explicit content controls: a per-user switch an admin can enforce, explicit songs gray and kept out of queues, radio, search, Home and Subsonic, and known clean versions in their place (server, web, iOS and Apple TV)
- [x] Public share links to albums, playlists and songs: expiring and revocable, a public page with previews or whole songs as the admin allows, managed in Settings and Admin → Sharing (server, web, and Share on iOS)

## 9. Apple TV

- [x] tvOS target and TestFlight upload pipeline under the existing Squirmy bundle ID
- [x] Rebuilt on Expo Router (`tv-app/`) for tvOS 17, with the system sidebar, context menus, search field and focus effects through native modules
- [x] Typed server connection and sign-in, remote navigation and library browsing
- [x] Now Playing, lyrics, queue and Connect playback transfer, and AirPlay from the playback device panel
- [x] Settings in the system's style: account, playback, library and scrobbling state
- [x] Layered app icon and Top Shelf images
- [ ] First tvOS TestFlight distribution

## 10. Playback core

Designed in [audio-engine.md](./audio-engine.md); each item is a pull request from its [implementation plan](./audio-engine.md#implementation-plan).

- [x] Design, with measurements of today's gaps and spikes of the new engine and formats
- [x] S1. Transcode priorities and cancelling abandoned encodes
- [x] S2. Exact lengths and priming per file, estimated gains for unmeasured files
- [x] S3. Fragmented MP4 profiles (FLAC, Opus, AAC) with exact gapless numbers, and seeking live transcodes
- [ ] C1. Queue diffs with checkpoints on the session socket
- [ ] C2. Undoing queue edits
- [x] M1. The native iOS and tvOS engine, behind a setting
- [ ] M2. Streaming to the cache in one pass
- [ ] M3. Fragmented MP4 transcodes and live seeking on iOS
- [x] M4. Normalization with boost and a true-peak limiter, with a target setting
- [ ] M5. Equalizer
- [ ] M6. Crossfade
- [ ] M7. Playback speed, with the rate in the session
- [ ] M8. AirPlay 2 buffering
- [ ] M9. The native engine by default, and `expo-audio` removed
- [x] W1. Ramped gain changes on the web
- [x] W2. Gapless web playback through Media Source Extensions (Chromium; Firefox and Safari keep today's engine)
- [ ] W3. Limiter, equalizer and output device on the web
- [ ] W4. Crossfade on the web

## Deferred

- Purchasing through acquisition providers (priced offers, caps, budgets)
