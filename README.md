# Squirmy

Squirmy is a self-hosted music server with a web app and an iOS app. It is being built out from an iOS prototype; [docs/roadmap.md](docs/roadmap.md) tracks what works today.

- [docs/plan.md](docs/plan.md): what the product does
- [docs/architecture.md](docs/architecture.md): how the code is organized

```
apps/mobile            Expo app
apps/server            API, worker and realtime server
packages/contracts     schemas shared by server and clients
packages/client-core   logic shared by the clients
```

## Run with Docker

```sh
MUSIC_DIR=/path/to/your/music docker compose up -d
```

Open http://localhost:4747 and create the admin account. The image contains the API, the worker, the web app, ffmpeg and fpcalc; `compose.yaml` adds PostgreSQL. Your music folder is mounted at `/music` and added as a library on first start. Append `:ro` to that volume in `compose.yaml` if the server must never change your files.

To build the image yourself, run `docker compose build`.

## Mobile app

The iOS app in `apps/mobile` connects to your Squirmy server, browses and searches your library, and plays it, in step with your other devices.

### Run locally

Use Node.js 22.13 or newer. Install from the repository root, then start Expo from `apps/mobile`.

```sh
npm ci
cd apps/mobile
npx expo start --go
```

With an SDK 58-compatible Expo Go installed, press `i` in the Expo terminal to preview on an iOS simulator. To build the standalone app in Xcode, run `npm run ios` in `apps/mobile`. The system Liquid Glass tab bar and mini-player accessory require iOS 26 or later.

### Development build on an iPhone

Set `SQUIRMY_APP_VARIANT=development` when generating and building the native project in a separate checkout. This installs Squirmy Dev alongside Squirmy. Start Metro from the checkout you are editing, with your Mac and iPhone on the same network.

```sh
SQUIRMY_APP_VARIANT=development npx expo start --dev-client --lan --scheme squirmy-dev
```

Open the project in Squirmy Dev using the terminal QR code or the Metro URL. JavaScript changes use Fast Refresh. Rebuild Squirmy Dev when native dependencies change.

### Using the app

On first launch the app asks for your server's address and signs in to it. After that it is your library: Home, Library (playlists, albums, artists and songs), Search, album, artist and playlist pages, and Now Playing with lyrics and the queue. The library is cached on the phone, so it opens instantly and stays browsable offline.

- Playback is the server-held session shared by all your devices. Whatever plays on the web or another phone shows here too, and the phone becomes a remote with no sound of its own. Playback Device, from the mini-player or Now Playing, moves playback between devices and sets the playing device's volume. Pressing play when nothing is playing makes this phone the player.
- Audio keeps playing in the background, with lock screen and Control Center controls.
- Tap the mini-player, or pull it up, to expand it. Drag down across the artwork or song details to collapse it. Swipe left or right on Now Playing to skip.
- In Queue, pull the list down for your listening history. Drag to reorder, or swipe a track for Play Next and Remove.
- Every song has a menu: play next or last, like, add to a playlist, start a radio, go to its album or artist. Songs that are not in your library are gray and can be added to your wantlist.
- Settings, in the account sheet, holds volume normalization, streaming quality on Wi-Fi and on cellular, and scrobbling to ListenBrainz and Last.fm.

### Engine bench

Development builds have a test bench for the native audio engine at `/dev/engine`, opened from the account sheet. It plays quiet test tones from a small local server:

```sh
node apps/mobile/scripts/engine-tones.mjs   # needs ffmpeg; serves on port 4800
```

The bench points at port 4800 on the machine running Metro. It loads, pauses, seeks, preloads and fails on purpose, shows every engine event in order, and puts the tone on the lock screen so the remote controls can be tried with the app in the background.

## Server

The server needs PostgreSQL 15 or newer with the `pg_trgm` extension, and `ffmpeg` on the PATH.

```sh
npm ci
npm run build:packages
DATABASE_URL=postgres://localhost:5432/squirmy npm run dev:api
```

Migrations run on start. The server listens on port 4747.

## Verify

```sh
npm run build:packages && npm run typecheck && npm run lint && npm test
(cd apps/mobile && npx expo export --platform ios)
```

Server tests create their own databases; point `SQUIRMY_TEST_DATABASE_URL` at a Postgres server they may use.

## License

GPL-3.0-or-later. See [LICENSE](LICENSE).
