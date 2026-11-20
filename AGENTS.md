# Working in this repository

Squirmy is a self-hosted music server with a web app and an iOS app. Read these before changing anything:

- [docs/plan.md](docs/plan.md): what the product does.
- [docs/architecture.md](docs/architecture.md): layout, conventions, module ownership, API routes. Follow it.
- [docs/roadmap.md](docs/roadmap.md): what is done and what is next.

## Rules

- Use Conventional Commits (`type(scope): concise imperative summary`).
- Never credit an AI in commits, pull requests or code. No co-author trailers, no "generated with" lines.
- Name branches like commits: `feat-...`, `fix-...`. Never prefix them with a tool name.
- Pull requests target `dev`. Include screenshots for UI changes, hosted in a gist. Never commit screenshots or other test evidence.
- Stay inside your module's folder, its contracts file and its tests. If you need a change elsewhere, make the smallest one that works and call it out in the pull request.
- The repository bundles no content sources and names no ripping or download tools.

## Checks

```sh
npm run build:packages && npm run typecheck && npm run lint && npm test
```

Documentation changes also need `npm run docs:build` to pass (it fails on dead links). Operator and user guides are in `docs/server/` and `docs/use/`; update the page a change affects.

Server tests need a Postgres they can create databases on: set `SQUIRMY_TEST_DATABASE_URL` (default `postgres://localhost:54329/postgres`). They also need `ffmpeg` and `fpcalc` on the PATH.

## Test audio

Generate fixtures with `apps/server/src/test/audio.ts`. They are short, very quiet tones with real tags. Never commit real music, and keep fixtures quiet: tests play them out loud on a developer's machine.

## Mobile

The Expo app is in `apps/mobile`. `ios/` and `android/` are generated and not committed. A patch for `react-native-screens` lives in the root `patches/` folder and is applied by the root `postinstall`.
