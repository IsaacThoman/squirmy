# Roadmap

Status of the milestones in [plan.md](./plan.md). Update this file in the pull request that changes a status.

## 1. Foundations

- [x] Monorepo: `apps/mobile`, `apps/server`, `packages/contracts`, `packages/client-core`
- [x] Contracts for auth, catalog, playback, sessions, search, user data, settings, library
- [x] Database schema for every milestone, initial migration, test harness
- [x] CI: lint, typecheck, build, tests against Postgres
- [x] semantic-release on `main`
- [ ] Shared session reducer and session client in `client-core`
- [ ] Docker image and `compose.yaml`

## 2. Your files, playing

- [ ] Server core: auth, users, invites, settings, jobs, realtime transport
- [ ] Library scan, tag reading, local-only catalog rows
- [ ] Artwork store and renditions
- [ ] Library and catalog read API, home
- [ ] Streaming: playback descriptor, signed URLs, Range, transcode cache
- [ ] Loudness measurement and normalization values
- [ ] Likes, playlists, history, user settings
- [ ] Web app: setup, login, library, album and artist pages, player, queue
- [ ] Mobile app: connect, login, real data, real audio, lock-screen controls

## 3. Connect

- [ ] Server-held session with command log and versions
- [ ] Device list, transfer, remote control
- [ ] Reconnect rule and device-lost handling
- [ ] Live invalidations on web and mobile

## 4. Identify and reorganize

- [ ] Metadata clients with cache and rate limits
- [ ] Album matching tiers, review queue, fix match, merges
- [ ] Enrichment: covers, artist images, bios, lyrics, external ids
- [ ] Managed roots: preview, apply, journal, undo
- [ ] Tag writing with verification

## 5. OpenSubsonic

- [ ] `/rest` router with XML and JSON
- [ ] App passwords and API keys
- [ ] Browsing, search, streaming, cover art, stars, playlists, scrobble, play queue, lyrics
- [ ] Client test pass

## 6. Search everything

- [ ] Library search
- [ ] Deezer and MusicBrainz search providers, stub rows, resolve on open
- [ ] Artist and album pages for music you do not own
- [ ] Wantlist and new-release feed
- [ ] Gray-out on web and mobile

## 7. Add and take

- [ ] Web upload and inbox folder
- [ ] Fingerprinting for untagged files
- [ ] Offline downloads on mobile

## 8. Providers and extras

- [ ] Acquisition provider protocol, on-demand playback, policy
- [ ] Reference adapters: cold storage and mock
- [ ] Scrobbling to ListenBrainz and Last.fm
- [ ] Radio and autoplay
- [ ] Local search index
- [ ] Documentation site

## Deferred

- Purchasing through acquisition providers (priced offers, caps, budgets)
- Bandcamp collection adapter
