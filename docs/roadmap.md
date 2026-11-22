# Roadmap

Status of the milestones in [plan.md](./plan.md). Update this file in the pull request that changes a status.

## 1. Foundations

- [x] Monorepo: `apps/mobile`, `apps/server`, `packages/contracts`, `packages/client-core`
- [x] Contracts for auth, catalog, playback, sessions, search, user data, settings, library
- [x] Database schema for every milestone, initial migration, test harness
- [x] CI: lint, typecheck, build, tests against Postgres
- [x] semantic-release on `main`
- [x] Shared session reducer and session client in `client-core`
- [x] Docker image and `compose.yaml`

## 2. Your files, playing

- [x] Server core: auth, users, invites, settings, jobs, realtime transport
- [x] Library scan, tag reading, local-only catalog rows
- [x] Artwork store and renditions
- [x] Library and catalog read API, home
- [x] Streaming: playback descriptor, signed URLs, Range, transcode cache
- [x] Loudness measurement and normalization values
- [x] Likes, ratings, playlists, history, user settings
- [x] Lyrics: embedded, sidecar and LRCLIB, shown on web and iOS
- [x] Web app: setup, login, library, album and artist pages, player, queue
- [x] Mobile app: connect, login, real data, real audio, lock-screen controls

## 3. Connect

- [x] Server-held session with command log and versions
- [x] Device list, transfer, remote control
- [x] Reconnect rule and device-lost handling
- [x] Live invalidations on web and mobile

## 4. Identify and reorganize

- [x] Metadata clients with cache and rate limits
- [x] Album matching tiers, review queue, fix match, merges
- [x] Enrichment: covers, artist images, bios, lyrics, external ids
- [x] Managed roots: preview, apply, journal, undo (server and API)
- [x] Admin screens (web): library folders, review queue, Fix match, Organize, users and invites, server settings, jobs
- [x] Tag writing with verification

## 5. OpenSubsonic

- [x] `/rest` router with XML and JSON ([subsonic.md](./server/subsonic.md))
- [x] App passwords and API keys
- [x] Browsing, search, streaming, cover art, stars, playlists, scrobble, play queue, lyrics
- [x] Client test pass: py-opensonic, py-sonic, subsonic-api (Node) and Airsonic Refix

## 6. Search everything

- [x] Library search
- [x] Deezer and MusicBrainz search providers, stub rows, stub cleanup
- [x] Resolve stubs on open (enrichment)
- [x] Artist and album pages for music you do not own
- [x] Similar artists on artist pages, genre pages
- [x] New-release feed on Home (server, web and iOS)
- [x] Wantlist (server, iOS add, web), opt-in behind `wantlistEnabled`
- [ ] Wantlist: hide it on the web while `wantlistEnabled` is off, add the switch to Admin → Server settings, and let iOS remove a want
- [x] Gray-out on web
- [x] Gray-out on mobile
- [x] One heart: hearting a song, album or artist is what saves it to the library, on web, iOS and Subsonic (stars); the web Library is one combined view like the phone's
- [x] iOS as a streaming app: one playable rule from client-core, one merged search list, a fetch shown as buffering ("Still loading…" after 8 s), one notice per failed song and one for an outage, and a library that only the heart (with Undo) changes

## 7. Add and take

- [x] Imports: upload API, inbox folder, staging, zip extraction, duplicates, filing into a managed root (server)
- [x] Upload screen in the web app: folders, files and zips with progress, pause and cancel; the imports list and detail; import settings
- [x] Fingerprinting for untagged files
- [x] Offline downloads on mobile

## 8. Providers and extras

- [x] Acquisition provider protocol, on-demand playback, policy ([provider-protocol.md](./provider-protocol.md)), and on the web the Providers admin screen, "Get this album" and preparing tracks
- [x] Reference adapters: cold storage and mock (`adapters/`)
- [x] Scrobbling to ListenBrainz and Last.fm (server, API, mobile and web settings)
- [x] Radio and autoplay (server, API, web and iOS, and Subsonic similar songs)
- [ ] Detached playback: one device plays its own queue apart from the shared session. Protocol, server and shared client code are done; the web and iOS controls are next ([detached-playback-ui.md](./detached-playback-ui.md))
- [x] Local search index: importer, search and admin routes ([local-search-index.md](./local-search-index.md)), offered as the first search provider, and its admin screen
- [x] Documentation site ([docs/](./index.md), built with VitePress)
- [x] Docker health check on `/ready`, and the image reports its source version

## Deferred

- Purchasing through acquisition providers (priced offers, caps, budgets)
