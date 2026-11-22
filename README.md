# Squirmy

Squirmy is a self-hosted music server with a web app and an iOS app. Point it at your music and it:

- **identifies and organizes your files**: tags are read, albums are matched against MusicBrainz, covers and lyrics are filled in, and managed folders can be renamed into a clean layout, with a preview and undo;
- **searches all music**: your library comes first, everything else shows gray and can go on an optional wantlist;
- **keeps one playback session across your devices**: start an album in the browser, continue on your phone, or use one as a remote for the other;
- **works with Subsonic apps** through an OpenSubsonic API.

Squirmy is young. [docs/roadmap.md](docs/roadmap.md) tracks what works today.

## Screenshots

<!-- The maintainer adds screenshots of the web app and the iOS app here. -->

## Quick start

You need Docker with Compose. The image is published as `ghcr.io/isaacthoman/squirmy` for amd64 and arm64, so all you download is the Compose file.

```sh
mkdir squirmy && cd squirmy
curl -fsSLO https://raw.githubusercontent.com/IsaacThoman/squirmy/main/compose.yaml
MUSIC_DIR=/path/to/your/music docker compose up -d
```

Open http://localhost:4747 and create the admin account. At the folder step your music folder is already listed: it is mounted at `/music`, added read-only and scanning, so choose **Continue**. The image contains the API, the worker, the web app, ffmpeg and fpcalc; `compose.yaml` adds PostgreSQL. Set `read_only: true` on the music volume in `compose.yaml` if the server must never change your files.

To build the image from the source instead, clone this repository and run `docker compose up -d --build` in it.

## Documentation

The documentation lives in [`docs/`](docs/) and builds into a site with `npm run docs:dev`.

- **Running a server:** [quick start](docs/server/quick-start.md), [configuration](docs/server/configuration.md), [reverse proxies and HTTPS](docs/server/reverse-proxy.md), [backup and moving](docs/server/backup.md), [troubleshooting](docs/server/troubleshooting.md)
- **Your music:** [library](docs/server/library.md), [organizing files](docs/server/organizing.md), [adding music](docs/server/adding-music.md), [metadata and privacy](docs/server/metadata-and-privacy.md), [playback](docs/server/playback.md)
- **People and apps:** [users and access](docs/server/users.md), [Subsonic clients](docs/server/subsonic.md), [scrobbling](docs/server/scrobbling.md), [acquisition providers](docs/server/acquisition.md)
- **Using it:** [web app](docs/use/web.md), [iOS app](docs/use/ios.md), [keyboard shortcuts](docs/use/keyboard-shortcuts.md), [wantlist](docs/use/wantlist.md)
- **Development:** [docs/plan.md](docs/plan.md) (what the product does), [docs/architecture.md](docs/architecture.md) (how the code is organized), [docs/provider-protocol.md](docs/provider-protocol.md)

## Development

```
apps/server            API, worker and realtime server
apps/web               web app
apps/mobile            Expo app
packages/contracts     schemas shared by server and clients
packages/client-core   logic shared by the clients
adapters/              reference acquisition providers
docs/                  this documentation
```

Use Node.js 22.13 or newer and install from the repository root:

```sh
npm ci
npm run build:packages
```

### Server

The server needs PostgreSQL 15 or newer with the `pg_trgm` extension, and `ffmpeg`, `ffprobe` and `fpcalc` on the PATH.

```sh
DATABASE_URL=postgres://localhost:5432/squirmy npm run dev:api
```

Migrations run on start. The server listens on port 4747. For music to try it with, generate a demo library of very quiet tones with real album names:

```sh
npm run demo:library -w @squirmy/server -- /tmp/squirmy-demo
DATABASE_URL=postgres://localhost:5432/squirmy SQUIRMY_LIBRARY_PATHS=/tmp/squirmy-demo npm run dev:api
```

### Web app

```sh
npm run dev:web
```

Vite serves the app on port 5173 and proxies `/api`, `/rest` and `/socket.io` to the server on 4747 (`SQUIRMY_API_URL` points it elsewhere).

### Mobile app

The iOS app is in `apps/mobile`. Start Expo from there:

```sh
cd apps/mobile
npx expo start --go
```

With an SDK 58-compatible Expo Go installed, press `i` in the Expo terminal to preview on an iOS simulator. To build the standalone app in Xcode, run `npm run ios` in `apps/mobile`. The system Liquid Glass tab bar and mini-player accessory require iOS 26 or later. [docs/use/ios.md](docs/use/ios.md) covers installing it on a phone and using it.

#### Development build on an iPhone

Set `SQUIRMY_APP_VARIANT=development` when generating and building the native project in a separate checkout. This installs Squirmy Dev alongside Squirmy. Start Metro from the checkout you are editing, with your Mac and iPhone on the same network.

```sh
SQUIRMY_APP_VARIANT=development npx expo start --dev-client --lan --scheme squirmy-dev
```

Open the project in Squirmy Dev using the terminal QR code or the Metro URL. JavaScript changes use Fast Refresh. Rebuild Squirmy Dev when native dependencies change.

#### Engine bench

Development builds have a test bench for the native audio engine at `/dev/engine`, opened from the account sheet. It plays quiet test tones from a small local server:

```sh
node apps/mobile/scripts/engine-tones.mjs   # needs ffmpeg; serves on port 4800
```

The bench points at port 4800 on the machine running Metro. It loads, pauses, seeks, preloads and fails on purpose, shows every engine event in order, and puts the tone on the lock screen so the remote controls can be tried with the app in the background.

### Documentation site

```sh
npm run docs:dev       # live preview
npm run docs:build     # what CI runs; dead links fail it
npm run docs:preview   # serve the built site
```

### Verify

```sh
npm run build:packages && npm run typecheck && npm run lint && npm test
npm run docs:build
(cd apps/mobile && npx expo export --platform ios)
```

Server tests create their own databases; point `SQUIRMY_TEST_DATABASE_URL` at a Postgres server they may use (default `postgres://localhost:54329/postgres`). They also need `ffmpeg` and `fpcalc`. To build the Docker image yourself, run `docker compose build`.

Contributors: read [AGENTS.md](AGENTS.md) for the rules (Conventional Commits, branch names, pull requests against `dev`).

## License

GPL-3.0-or-later. See [LICENSE](LICENSE).
