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

## Mobile app

The app in `apps/mobile` is still the prototype: browse the fictional catalog, open an album, and tap the mini-player to open Now Playing. Playback, favorites, queue state, and the selected output persist locally.

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

### Try the prototype

- Tap the mini-player, or pull it up, to expand it. Tap the grabber or drag down across the artwork or song details to collapse it back into the mini-player. Either way the player follows your finger, and you can let go partway.
- Swipe left on Now Playing for the next track or right for the previous-track action. The Lyrics and Queue buttons sit below the volume slider. Tap either button again to return to the artwork.
- In Queue, pull the list down to reveal tracks played earlier. Scroll past Up Next for Autoplay. Drag a reorder handle, or swipe left on a track for Play Next and Remove.
- Open any album and tap the heart next to a song’s overflow button. Find it again in Library under Liked Songs.
- Open Playback Device from the mini-player or Now Playing to move the simulated output. The mini-player and Now Playing continue to display and control the same playback session when the output changes.

On first launch the app asks for your server's address and signs in to it; an account button on Home shows the server and signs out or switches servers. Behind the sign-in, the screens still show the prototype.

The playback clock, music catalog, lyrics, autoplay, and device switching are demo data and behavior. The prototype does not stream audio, connect to physical playback devices, or synchronize separate app installations.

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
