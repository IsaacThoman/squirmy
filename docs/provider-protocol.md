# Acquisition provider protocol

Version 1.

An acquisition provider is a small HTTP service you run next to Squirmy that can supply audio files for music the server does not have yet. When one is connected, tracks it can supply stop being gray: playing one fetches the file in the background, files it into the library like any other import, and starts playback when it arrives.

Squirmy ships no providers that fetch from third parties and names none. The protocol is generic; what you connect is your decision and your responsibility. The repository includes two reference adapters: one that serves files from a cold-storage folder you already own, and a mock used in tests.

The schemas for every message are in `packages/contracts/src/acquisition.ts` (names start with `Provider`).

## Overview

```
server                                   provider
  │  GET  /capabilities                    │   once, and when you press "Test"
  │  POST /resolve     { items }           │   what can you supply?
  │ ◄──── { items: [{ ref, offers }] }     │
  │  POST /acquire     { jobId, offerId,   │   fetch this one
  │                      delivery }        │
  │ ◄──── { accepted, providerJobId }      │
  │                                        │
  │ ◄──── POST delivery.uploadUrl (files)  │   provider calls back
  │ ◄──── POST delivery.completeUrl        │
  │  GET  /jobs/{providerJobId}            │   only if the provider goes quiet
```

All bodies are JSON except the file upload. All paths are relative to the provider's base URL.

## Authentication

- **Server to provider.** Every request carries `Authorization: Bearer <secret>`, the shared secret you entered when adding the provider. Reject anything else with 401.
- **Provider to server.** The `delivery` object in an acquire request contains a token that is valid only for that job's upload and completion URLs. Send it as `Authorization: Bearer <token>`.

## `GET /capabilities`

Describes the provider.

```json
{
  "protocol": 1,
  "name": "Cold storage",
  "coverage": "must_resolve",
  "kinds": ["recording", "album"],
  "formats": ["flac", "mp3"],
  "maxConcurrent": 2
}
```

`coverage` decides how tracks appear before anyone asks for them:

- `must_resolve`: a track is playable on demand only after a `resolve` call returned an offer for it. Use this when the provider knows exactly what it has.
- `assume_available`: every track shows as playable on demand. If a later request finds nothing, that track turns gray and is not asked for again for a while.

## `POST /resolve`

Asks what the provider can supply. Up to 100 items per call. Each item has a `ref` that the response echoes.

```json
{
  "items": [
    {
      "ref": "1",
      "kind": "recording",
      "recording": {
        "mbid": "9f9cf187-d6f9-437f-9d98-d59cdbd52757",
        "isrcs": ["GBAYE9700107"],
        "title": "Paranoid Android",
        "artist": "Radiohead",
        "durationMs": 387000,
        "album": { "title": "OK Computer", "mbid": "b1392450-e666-3926-a536-22c65f834433", "year": 1997, "disc": 1, "position": 2 }
      }
    }
  ]
}
```

Any identifying field may be null or empty; match on what is present, most specific first (MusicBrainz id, ISRC, then artist, title and duration).

```json
{
  "items": [
    {
      "ref": "1",
      "offers": [
        { "offerId": "flac:9f9cf187", "format": "flac", "lossless": true, "sampleRate": 44100, "bitDepth": 16, "bytes": 41200000, "etaSeconds": 5 }
      ]
    }
  ]
}
```

An item with an empty `offers` array cannot be supplied. `offerId` is opaque to the server. Respond within 15 seconds.

The `price` field on an offer is reserved for purchasing. This version of the server ignores any offer that has one.

## `POST /acquire`

Starts fetching one offer.

```json
{
  "jobId": "0193a5c2-7b1e-7c3a-9d2f-5e8a4b6c1d20",
  "offerId": "flac:9f9cf187",
  "delivery": {
    "uploadUrl": "https://music.example.com/api/v1/acquisition/deliveries/0193a5c2-…/files",
    "completeUrl": "https://music.example.com/api/v1/acquisition/deliveries/0193a5c2-…/complete",
    "token": "…"
  }
}
```

Respond quickly with `{ "accepted": true, "providerJobId": "…" }` and do the work in the background, or `{ "accepted": false, "error": "…" }`. The server may send the same `jobId` twice; treat it as an idempotency key and do not fetch twice.

## Delivering files

1. `POST delivery.uploadUrl` as `multipart/form-data` with one or more `file` parts. Keep the original filename and extension. An album may be sent in one request or several.
2. `POST delivery.completeUrl` with `{ "status": "completed" }`, or `{ "status": "failed", "error": "…" }`.

The server then runs its normal import: read tags, identify, file into the library. Before a delivered file is linked to the requested track it is checked against the request (duration, and fingerprint when available). A file that does not match is quarantined and the job fails.

## `GET /jobs/{providerJobId}`

Polled only when a job has had no upload or completion for a while.

```json
{ "status": "running", "progress": 0.4 }
```

`status` is `queued`, `running`, `completed` or `failed`. A job that is still not complete after the operator's timeout is marked failed on the server.

## What the server enforces

- Only users the operator has allowed may trigger a fetch.
- Per-file size limit, optional total storage quota, concurrency per provider.
- Every job is recorded with who asked, what for, which provider, and the outcome.
- Files that arrive this way are marked with their source, so they can be listed and removed.
