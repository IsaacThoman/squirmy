# Mock provider

An acquisition provider for tests and demos. Whatever it is asked for, it delivers a near-silent sine tone of the requested length (FLAC, -50 dB), tagged with the requested title, artist, album, MusicBrainz id and ISRC. Each title and artist gets its own pitch, so different tracks never look like duplicates to the server. Needs `ffmpeg` on the `PATH` (or `FFMPEG_PATH`).

The server's tests run it in-process (`createMockProvider()` from `@squirmy/adapter-mock`) and flip its switches at runtime. From the command line:

```sh
npm run build:packages && npm run build:adapters
PORT=4801 MOCK_PROVIDER_SECRET=mock-secret npm start -w @squirmy/adapter-mock
```

| Variable | Default | |
|---|---|---|
| `PORT`, `HOST` | `4801`, `0.0.0.0` | |
| `MOCK_PROVIDER_SECRET` | `mock-provider-secret` | Shared secret. |
| `MOCK_PROVIDER_COVERAGE` | `assume_available` | Or `must_resolve`. |
| `MOCK_PROVIDER_DELAY_MS` | `0` | Wait this long before each delivery: a slow provider. |
| `MOCK_PROVIDER_FAIL` | off | `1`: accept jobs, then report them failed. |
| `MOCK_PROVIDER_WRONG_FILE` | off | `1`: deliver a tone with another title and length. |
| `MOCK_PROVIDER_PRICED` | off | `1`: put a price on every offer (the server ignores priced offers). |
