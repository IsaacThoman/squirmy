# Acquisition provider protocol

Version 1.

An acquisition provider is a small HTTP service you run next to Squirmy that can supply audio files for music the server does not have yet. When one is connected, tracks it can supply stop being gray: playing one fetches the file in the background, files it into the library like any other import, and starts playback when it arrives.

Squirmy ships no providers that fetch from third parties and names none. The protocol is generic; what you connect is your decision and your responsibility. The repository includes two reference adapters: one that serves files from a cold-storage folder you already own ([adapters/cold-storage](https://github.com/IsaacThoman/squirmy/blob/dev/adapters/cold-storage/README.md)), and a mock used in tests and demos ([adapters/mock](https://github.com/IsaacThoman/squirmy/blob/dev/adapters/mock/README.md)). Both are built on `@squirmy/provider-kit` (`adapters/kit`), which implements everything below except "what do you have" and "fetch it", so a new provider is mostly those two functions.

The schemas for every message are in `packages/contracts/src/acquisition.ts` (names start with `Provider`).

## Connecting a provider

An admin adds a provider with its base URL and shared secret in **Admin → Providers** (`POST /api/v1/admin/acquisition/providers`); the server calls `GET /capabilities` right away and again whenever the provider is tested (`POST /api/v1/admin/acquisition/providers/:id/test`). The [operator guide](./server/acquisition.md) walks through the screen. A provider counts only while it is enabled and has answered `capabilities` once. With several, they are tried in descending priority.

The server tells a provider where to deliver with absolute URLs. Their origin is, in order: the policy's `deliveryBaseUrl` (`PATCH /api/v1/admin/acquisition/policy`), `PUBLIC_URL`, or `http://localhost:<PORT>`. A provider in another container needs one of the first two, for example `deliveryBaseUrl: "http://squirmy:4747"` on a shared Docker network.

## Overview

```
server                                   provider
  │  GET  /capabilities                    │   once, and again on each test call
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

- `must_resolve`: a track is playable on demand only after a `resolve` call returned an offer for it. Use this when the provider knows exactly what it has. The server asks about tracks as lists show them, in batches of up to 100, and remembers the answers: offers for 30 days, "nothing" for a day.
- `assume_available`: every track shows as playable on demand. If a later request finds nothing, or the delivery fails, that track turns gray for a day and is not asked for again until then.

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

An `album` item asks for a whole release group (`ProviderAlbumQuery`: title, artist, MusicBrainz id, barcode and the track list). The server sends album items only to providers whose `kinds` include `album`; otherwise an album request becomes one recording request per missing track.

When several offers come back, the server takes lossless ones first (or lossy first when the operator turns `preferLossless` off), then the highest quality: sample rate × bit depth for lossless, bitrate for lossy. Expired offers (`expiresAt` in the past) are skipped.

The `price` field on an offer is reserved for purchasing. This version of the server ignores any offer that has one: it is never chosen, and a track with only priced offers stays gray.

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

Respond quickly with `{ "accepted": true, "providerJobId": "…" }` and do the work in the background, or `{ "accepted": false, "error": "…" }` (the job then ends as `rejected`). The server may send the same `jobId` twice, after a restart; treat it as an idempotency key and do not fetch twice, but use the `delivery` from the latest request: it carries a new token, and the old one no longer works.

The server sends at most `maxConcurrent` jobs to a provider at once; others wait their turn.

## Delivering files

1. `POST delivery.uploadUrl` as `multipart/form-data` with one or more `file` parts. Keep the original filename and extension. A text field `relativePath` sent just before a file part names its path inside the delivery (`Album/01 Song.flac`), which keeps an album's files together. An album may be sent in one request or several. The answer is `ProviderUploadResponse`: each file `accepted`, or `rejected` with a reason (not audio, an unsafe name). A file larger than the operator's per-file limit (`maxFileBytes`) ends the request with 413 and fails the job.
2. `POST delivery.completeUrl` with `{ "status": "completed" }`, or `{ "status": "failed", "error": "…" }`.

Both URLs answer 401 `invalid_delivery_token` for a missing or wrong token (including another job's), 409 `job_not_active` once the job has ended, and 429 past 120 requests a minute per job and address.

The server then runs its normal import: read tags, identify, file into the library. Then it checks the delivery against the request. A requested track is delivered when, after the import:

- the pipeline linked a delivered file to it (for example by the MusicBrainz id in its tags); or
- a delivered file is plainly the same recording: it shares an ISRC with it, or has the same title and artist ("Artist feat. Other" counts as "Artist") with a length within 5 seconds. With an AcoustID key configured and a MusicBrainz id requested, AcoustID must not name only other recordings for the file. Two different MusicBrainz ids are never the same recording.

In the second case the two catalog rows are merged, so the id that queues and playlists hold plays: a row with a MusicBrainz id wins over one without, otherwise the requested row wins. A file that does not match stays where the import left it, marked as coming from the provider (`media_files.source = provider:<id>`), is never linked to the requested track, and the job fails.

## `GET /jobs/{providerJobId}`

Polled only when a job has had no upload or completion for a while.

```json
{ "status": "running", "progress": 0.4 }
```

`status` is `queued`, `running`, `completed` or `failed`. The server polls a job that has had no upload or completion for a minute. `failed` fails the job; `completed` is treated as a completion. A job that has not delivered within the operator's timeout (`timeoutSeconds`, 15 minutes by default) is marked failed on the server, and later uploads for it are refused.

## On the server

A job goes `resolving → queued → downloading → importing → completed`, or ends `failed` or `rejected`. Each change is published to the requesting user as `acquisition.updated`. A playback session waiting on the track (`preparing`) becomes `ready` as soon as a delivered file has been read, linked and checked against the request, while identification and filing carry on, and `failed` (and is skipped) when the job fails. If identification later finds the file is a different recording, the job fails then: the track is not cut off if it is already playing, but later plays of it fail. A failed job records a miss, so the track is gray for a day. `GET /api/v1/admin/acquisition/jobs` lists every job with who asked, the provider, the status and the error.

## What the server enforces

- Only users the operator has allowed may trigger a fetch (admins, and members with "can acquire").
- One job in flight per track or album: requests from several devices or users join it.
- Per-file size limit, optional total storage quota (requests are refused once acquired files fill it), concurrency per provider.
- Every job is recorded with who asked, what for, which provider, and the outcome.
- Files that arrive this way are marked with their source, so they can be listed and removed.
- Every call to a provider has a timeout, sends the shared secret, follows redirects only within the provider's own address, reads at most 4 MiB, and is validated against the schemas. A provider that misbehaves fails its own jobs and nothing else.
