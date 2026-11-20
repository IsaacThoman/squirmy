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
- [x] Likes, playlists, history, user settings
- [ ] Web app: setup, login, library, album and artist pages, player, queue
- [x] Mobile app: connect, login, real data, real audio, lock-screen controls

## 3. Connect

- [x] Server-held session with command log and versions
- [ ] Device list, transfer, remote control (mobile done; web to do)
- [ ] Reconnect rule and device-lost handling (mobile done; web to do)
- [ ] Live invalidations on web and mobile (mobile done)

## 4. Identify and reorganize

- [ ] Metadata clients with cache and rate limits
- [x] Album matching tiers, review queue, fix match, merges
- [x] Enrichment: covers, artist images, bios, lyrics, external ids, new-release feed (server)
- [x] Managed roots: preview, apply, journal, undo (server and API)
- [x] Admin screens for library folders, the review queue, Fix match and Organize (web)
- [x] Tag writing with verification

## 5. OpenSubsonic

- [x] `/rest` router with XML and JSON ([subsonic.md](./subsonic.md))
- [x] App passwords and API keys
- [x] Browsing, search, streaming, cover art, stars, playlists, scrobble, play queue, lyrics
- [x] Client test pass: py-opensonic, py-sonic, subsonic-api (Node) and Airsonic Refix

## 6. Search everything

- [x] Library search
- [x] Local index, Deezer and MusicBrainz search providers, stub rows, stub cleanup
- [ ] Resolve stubs on open (enrichment)
- [ ] Artist and album pages for music you do not own
- [ ] Wantlist and new-release feed
- [ ] Gray-out on web and mobile

## 7. Add and take

- [x] Imports: upload API, inbox folder, staging, zip extraction, duplicates, filing into a managed root (server)
- [ ] Upload screen in the web app
- [x] Fingerprinting for untagged files
- [ ] Offline downloads on mobile

## 8. Providers and extras

- [ ] Acquisition provider protocol, on-demand playback, policy
- [ ] Reference adapters: cold storage and mock
- [x] Scrobbling to ListenBrainz and Last.fm (server, API and mobile settings; web settings to do)
- [x] Radio and autoplay (server and API)
- [x] Local search index: importer, search and admin routes ([local-search-index.md](./local-search-index.md)), offered as the first search provider, and its admin screen
- [ ] Documentation site

## Deferred

- Purchasing through acquisition providers (priced offers, caps, budgets)
- Bandcamp collection adapter
