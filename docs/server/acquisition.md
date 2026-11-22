# Acquisition providers

An acquisition provider is a separate service, run by you next to Squirmy, that can supply audio files for music the server does not have yet. With one connected, tracks it can supply stop being gray: playing one fetches the file in the background, imports it like any other music, and starts playback when it arrives.

This page explains how to connect one, the coverage modes, the policy settings, what users see, and how deliveries are checked, with the bundled cold-storage provider as a worked example.

## Before you start

- **It is off by default.** Nothing is fetched and no provider is contacted until an admin adds one.
- **Squirmy ships no providers that fetch from third parties and names none.** The [protocol](../provider-protocol.md) is generic. What you connect is your decision and your responsibility.
- The repository includes two reference providers: **cold storage**, which serves files from a folder of your own music that you keep off the main library, and a **mock** that makes quiet test tones, for trying the feature out.
- **Priced offers are ignored in this version.** The protocol reserves a `price` field for a later purchasing feature. Until then the server never chooses an offer that has one, and a track with only priced offers stays gray.
- Acquired music is filed into a [managed folder](./organizing.md#make-a-folder-managed), so you need one.

## Connecting a provider

In **Admin → Providers**:

1. **Add provider**, with a name, its base URL and the shared secret you configured on the provider (at least 8 characters). The server asks it for its capabilities right away; the card shows what it reports (its name, single songs or whole albums, formats, how many requests at once) and when it last answered, or its last error. **Test connection** asks again. The secret is never shown again; editing leaves it alone unless you type a new one.
2. **Tell the provider where to deliver**, under **Policy → Delivery address**, when it reaches the server at another address than `PUBLIC_URL` or `http://localhost:4747` (see below).
3. **Allow people to fetch.** Admins always can. For members, turn on **Can fetch missing music** in **Admin → Users & invites**.

The switch on a provider's card turns it off and on, and its menu edits or deletes it. **Requests**, at the bottom, lists every fetch with who asked, what for, the provider, the state and the error, as they happen; filter it by state.

### Through the API

All of these need an admin token:

```sh
SERVER=https://music.example.com
TOKEN=$(curl -s -X POST $SERVER/api/v1/auth/login -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"your password"}' | jq -r .token)
```

1. **Add it** with its base URL and the shared secret you configured on the provider (at least 8 characters):

   ```sh
   curl -s -X POST $SERVER/api/v1/admin/acquisition/providers \
     -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
     -d '{"name":"Cold storage","baseUrl":"http://cold-storage:4800","secret":"the shared secret"}'
   ```

   The server asks the provider for its capabilities right away. The answer shows them, `coverage`, and `lastError: null` when it worked. The secret is never returned.

2. **Tell the provider where to deliver.** The provider uploads files back to Squirmy at a URL the server gives it. That URL starts with the policy's `deliveryBaseUrl`, else `PUBLIC_URL`, else `http://localhost:4747`. A provider in another container usually needs the address of Squirmy on the Docker network:

   ```sh
   curl -s -X PATCH $SERVER/api/v1/admin/acquisition/policy \
     -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
     -d '{"deliveryBaseUrl":"http://app:4747"}'
   ```

3. **Allow people to fetch.** Admins always can. For members, turn on **Can fetch missing music** in **Admin → Users & invites**.

Other calls:

| Call | What it does |
|---|---|
| `GET /api/v1/admin/acquisition/providers` | Lists providers with their capabilities, last success and last error. |
| `POST /api/v1/admin/acquisition/providers/:id/test` | Asks for capabilities again. |
| `PATCH /api/v1/admin/acquisition/providers/:id` | Changes `name`, `baseUrl`, `secret`, `enabled`, `priority` or `coverage` (see [Coverage modes](#coverage-modes)). With several providers, higher priority is tried first. |
| `DELETE /api/v1/admin/acquisition/providers/:id` | Removes it. |
| `GET /api/v1/admin/acquisition/jobs` | Every fetch: who asked, for what, why (`origin`), which provider, status and error. |
| `GET /api/v1/admin/acquisition/usage` | The fetched-music cache: `cachedFiles`, `cachedBytes`, `pinnedBytes` and `limitBytes` (see [The cache](#the-cache)). |

## Coverage modes

A provider says how it covers music, which decides what turns from gray to playable:

- **`must_resolve`**: a track is shown as playable on demand only after the provider confirmed it has it. The server asks about tracks as lists and pages show them, in batches of up to 100, and remembers the answers: offers for 30 days, "nothing" for a day. Lists update a moment later, once the answers arrive. Cold storage works this way.
- **`assume_available`**: every track you do not own shows as playable on demand, and so does an album found by search before its track list is known. When a request finds nothing, or a delivery fails, that track turns gray for a day.

The provider declares its mode, but you can set it: `PATCH /api/v1/admin/acquisition/providers/:id` with `{"coverage":"assume_available"}`. Do this for a provider that can fetch nearly anything, so search results are playable on first sight instead of a moment later. Your choice stays when the server asks the provider for its capabilities again; set the other value to change it back.

## Policy

Under **Admin → Providers → Policy**, or `GET` and `PATCH /api/v1/admin/acquisition/policy`:

| Key | Default | What it does |
|---|---|---|
| `preferLossless` | `true` | With several offers, take lossless first, then the highest quality. |
| `maxFileBytes` | 500 MiB | A delivered file above this fails the job. A job may receive 1.25 × this per requested track in all, and four files per track plus two (audio, cover, lyrics, cue sheet); more fails the job. |
| `storageQuotaBytes` | `0` (no limit) | The cache limit: once fetched music adds up to more, the least recently played files nobody holds on to are deleted, down to 90%. A fetch is never refused because of it. See [The cache](#the-cache). |
| `timeoutSeconds` | `900` | A job that has not delivered by then fails. 30 to 86,400. |
| `targetRootId` | `null` | The managed folder acquired music goes into. `null` uses the same folder as uploads (`importRootId`, else the only managed folder). |
| `deliveryBaseUrl` | `null` | The origin of the delivery URLs handed to providers. |

## The cache

Everything a provider delivers is cache, not part of anyone's library. Playing a track fetches it and keeps its file so it plays at once next time; adding to a library is only ever the **Add to library** action. Fetched files:

- are filed under `_Fetched/` in the managed folder, with the folder's usual layout inside, so your own folders hold only music you brought;
- open no reviews, are left out of **Imports** (`GET /imports?kind=acquisition` lists them) and of the counts in **Admin → Library**, and are counted by `GET /admin/acquisition/usage` instead;
- are deleted when they are not what was asked for (another song, an extra track nobody uses, a file nothing identified), rather than kept for review.

With `storageQuotaBytes` set, an hourly job (and one after each fetch that goes over the limit) deletes the least recently played files until the cache is under 90% of the limit. A file is never deleted while anyone has saved its album or the track, likes either, has the track in a playlist or in their queue, or played it in the last 24 hours, nor in its first hour on the server. A deleted track is still playable: the next play fetches it again. If what people hold on to is more than the limit, everything else goes and the cache stays over it; raise the limit. With `0` nothing is deleted.

Files outside a managed folder are never deleted, and a fetched file you move out of `_Fetched/` yourself becomes part of your collection. An upload or inbox file is never dropped as a duplicate of a fetched file. If the database is ever restored without them, files found under a managed folder's `_Fetched/` are taken back in as cache.

Upgrading from a version where the quota refused new fetches: if fetched music was already near the quota, the first hourly run deletes everything unpinned down to 90% of it.

## Limits

- One fetch runs per track or album at a time. If two people or devices ask for the same thing, they share it.
- Waiting fetches start in this order: the track being played, then tracks coming up in a queue, then downloads to a device, then **Add to library**. A playing track never waits behind a library save.
- A member allowed to fetch can have 100 fetches running at once (admins have no limit); `POST /tracks/:id/acquire` and `POST /albums/:id/acquire` take 120 requests a minute per user.

## What users see

- Albums and tracks a provider can supply show a cloud icon, "Plays on demand", in the web app; the [iOS app](../use/ios.md#on-demand-songs) marks such songs with a small cloud next to the artist. A web album page offers **Get this album**, which fetches its missing songs and shows how many have arrived; the menu offers it on albums you have part of.
- Pressing play queues them as usual. A track being fetched shows **Preparing…** wherever it appears (lists, the queue, the player and Now Playing), and the session waits at its start; it plays as soon as the file arrives. Upcoming tracks in the queue are fetched ahead of time.
- If a fetch fails, a notice says so, the track is skipped, and it shows gray for a day. Upcoming tracks that fail are skipped when reached. When three tracks in a row fail (a provider outage, say), playback pauses on the third rather than skipping through the queue.
- Autoplay and radios include tracks the provider can fetch for members allowed to fetch, after two tracks the server already has; other members get only tracks on the server.
- A member without **Can fetch missing music** sees those tracks gray, and their row and menu say to ask an admin.
- Subsonic apps never see on-demand music; they show only what is on the server.

## How deliveries are verified

A delivery goes through the normal [import pipeline](./adding-music.md#what-an-import-does): tags are read, the album is identified, and it is filed into the managed folder. Then the server checks that what arrived is what was asked for. A requested track counts as delivered when:

- the import linked a delivered file to it (for example by the MusicBrainz id in the file's tags); or
- a delivered file is plainly the same recording: it shares an ISRC, or has the same title and artist with a length within 5 seconds. With an AcoustID key set and a MusicBrainz id requested, AcoustID must not identify the file only as other recordings. Two different MusicBrainz ids never count as the same recording.

When the file is linked to a track the server already has other files for (its tags carry that track's MusicBrainz id), the provider's word is not enough: the requested track must share an ISRC with that track in the server's own catalog, or AcoustID must identify the file as it. A provider cannot swap the audio of a track everyone plays by tagging a file that way.

A file that does not match is deleted, is never linked to the requested track, and the job fails. So are extra files the request did not ask for, unless one is the only copy of a track and already in use (queued, liked, saved, or fetched for someone else), which is kept as cache. An empty audio file is refused on upload.

Every call to a provider has a timeout, sends the shared secret, follows redirects only within the provider's own address and reads at most 4 MiB. A misbehaving provider fails its own jobs and nothing else.

## Worked example: cold storage

The cold-storage provider is for music you own but keep off the server's library: an archive disk, a slow NAS, a bucket mounted as a folder. It indexes the tags of every audio file under one folder (read-only) and matches requests by MusicBrainz recording id, then ISRC, then artist, title and length. Delivery uploads the file as it is, unconverted.

1. Add a service to the `compose.yaml` in a clone of the repository. The provider's image is not published, so Compose builds it from the source:

   ```yaml
   services:
     cold-storage:
       build:
         context: .
         dockerfile: adapters/cold-storage/Dockerfile
       restart: unless-stopped
       environment:
         COLD_STORAGE_DIR: /archive
         COLD_STORAGE_SECRET: ${COLD_STORAGE_SECRET:?set a secret}
       volumes:
         - /mnt/archive/music:/archive:ro
   ```

2. Put a secret of at least 8 characters in `.env` as `COLD_STORAGE_SECRET=…`, and run `docker compose up -d --build cold-storage`, which builds and starts only the provider. The log (`docker compose logs cold-storage`) says how many files it indexed.
3. Add it with base URL `http://cold-storage:4800` and the same secret, and set `deliveryBaseUrl` to `http://app:4747`, as in [Connecting a provider](#connecting-a-provider).
4. Open an album that is in the archive but not in the library. Within a few seconds it shows "Plays on demand". Press play.

Its other settings: `COLD_STORAGE_NAME` (default `Cold storage`), `COLD_STORAGE_RESCAN_MINUTES` (default `60`; `0` never rescans), `COLD_STORAGE_MAX_CONCURRENT` (default `2`), `PORT` (default `4800`). See [its README](https://github.com/IsaacThoman/squirmy/blob/dev/adapters/cold-storage/README.md).

This flow was tested end to end with the provider and the server running directly on one machine (an album moved out of the library turned "on demand", was fetched and imported); the Compose setup above has not been run.

To try the feature without an archive, run the [mock provider](https://github.com/IsaacThoman/squirmy/blob/dev/adapters/mock/README.md), which answers every request with a quiet test tone of the right length.

## Writing your own

A provider is a small HTTP service with three calls: `GET /capabilities`, `POST /resolve` (what can you supply?) and `POST /acquire` (fetch this one), and it delivers by uploading to the URL it was given. `@squirmy/provider-kit` in `adapters/kit` implements everything except "what do you have" and "fetch it". The [provider protocol](../provider-protocol.md) specifies every message.
