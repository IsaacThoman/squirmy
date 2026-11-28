# Local search index

An optional catalog search that runs entirely on your server. You load MetaBrainz's "canonical MusicBrainz data" dump into Postgres once, and from then on searching for any artist, album or song is answered locally in milliseconds, without asking a third-party API. It is off until an admin runs the first import.

The code is in `apps/server/src/modules/catalog-index/`; the admin API contracts are in `packages/contracts/src/catalog-index.ts`.

## The data

MetaBrainz publishes the dump at <https://data.metabrainz.org/pub/musicbrainz/canonical_data/>, one folder per dump, named after the time it was made (UTC):

```
musicbrainz-canonical-dump-20261117-080003/
  musicbrainz-canonical-dump-20261117-080003.tar.zst          2.4 GB
  musicbrainz-canonical-dump-20261117-080003.tar.zst.md5
  musicbrainz-canonical-dump-20261117-080003.tar.zst.sha256
```

The documentation says it is updated twice a month, on the 1st and 15th; in November 2026 the listing held dumps from the 3rd and the 17th, so expect one roughly every two weeks. The listing held only those two.

The archive is a tar (with PAX headers) compressed with zstd as a single frame, so it can only be read from the start. Inside one folder:

| File | Size (17 Nov 2026) | Contents |
|---|---|---|
| `TIMESTAMP` | 26 bytes | When the dump was made, e.g. `2026-11-17 08:00:03.201155` (UTC) |
| `COPYING` | 6 KB | The CC0 1.0 legal code |
| `canonical/canonical_musicbrainz_data.csv` | 7.8 GB | One row per distinct artist credit and recording title, roughly 30 to 35 million rows |
| `canonical/canonical_recording_redirect.csv` | not measured | Every other recording with the same artist credit and title, pointing at the row above |
| `canonical/canonical_release_redirect.csv` | not measured | Every release, with its release group and that group's canonical release |

The redirect files come after the 7.8 GB file in the single compressed stream, so their sizes could not be read without downloading the whole dump.

The CSV files are RFC 4180 with a header line: fields containing commas, quotes or line breaks are quoted, and quotes are doubled.

**`canonical_musicbrainz_data.csv`**, ordered by artist credit:

| Column | Meaning |
|---|---|
| `id` | Row number |
| `artist_credit_id` | MusicBrainz's internal artist credit id |
| `artist_mbids` | MBIDs of the credited artists, comma-separated in credit order (so the field is quoted when there are several) |
| `artist_credit_name` | The credit as printed, e.g. `Simon & Garfunkel` |
| `release_mbid`, `release_name` | The most canonical release the recording appears on |
| `recording_mbid`, `recording_name` | The canonical recording |
| `combined_lookup` | Artist credit and title joined, lowercased, punctuation and spaces removed and transliterated to ASCII (Python's Unidecode), e.g. `thebeatlesyesterday`. ListenBrainz uses it to match listens; the dump keeps only the best row per value. |
| `score` | The position of the release in MusicBrainz's canonical release order, lower is more canonical. It sorts by release group type (albums first), then medium format, then release date. It is not popularity. |

**`canonical_recording_redirect.csv`**: `recording_mbid`, `canonical_recording_mbid`, `canonical_release_mbid`. A recording that lost to another with the same `combined_lookup` (a live take, a remaster, a re-recording with the same title) points at the winner.

**`canonical_release_redirect.csv`**: `release_mbid`, `canonical_release_mbid`, `release_group_mbid`. Every release in MusicBrainz, its release group, and the group's canonical release.

The definitions are in MetaBrainz's documentation (<https://wiki.musicbrainz.org/Canonical_MusicBrainz_data>, <https://metabrainz.org/datasets/derived-dumps>) and in the ListenBrainz code that builds the dump (`mbid_mapping/mapping/canonical_*.py` and `listenbrainz/dumps/mapping.py` in `metabrainz/listenbrainz-server`).

### Licence

The data is released under **Creative Commons Zero (CC0 1.0)**: public domain, no attribution required, commercial use allowed. MetaBrainz asks commercial users to support the foundation financially, on a moral rather than legal basis. Squirmy ships none of the data; each server downloads it from MetaBrainz.

## What gets indexed

The importer derives three kinds of rows:

- **Recordings**: one per row of the main file, with its credited artist and the album it is best known from.
- **Albums**: one per release group, named after its most canonical release in the dump. The artist is the credit on most of its tracks, or "Various Artists" when no credit covers half of them.
- **Artists**: one per artist that has recordings credited to them alone, under the name they are most often credited with. Various Artists and the bracketed special-purpose artists (`[unknown]`, `[traditional]`) are left out.

Every row gets a popularity score from 0 to 1. The dump has no play counts, but how much MusicBrainz holds about something tracks fame well:

- a recording's **versions**: how many other recordings redirect to it. Hits are recorded live, remastered and re-recorded again and again;
- an album's **editions**: how many releases are in its release group. Famous albums have hundreds of pressings;
- an artist's **size**: recordings credited to them plus all of their versions.

Each count is taken as ln(1 + n) and scaled against the 99.9th percentile of its kind. Albums and recordings blend their own count (half) with their artist's size (40%) and the dump's canonical order (10%), so the original album outranks a reissue.

Known gaps, all a consequence of what the dump contains:

- A compilation whose every track is canonical somewhere else (a greatest-hits album) has no row in the main file, so it is not indexed.
- An artist who only ever appears in shared credits ("A feat. B") has no credit name of their own and is not indexed as an artist; their recordings are.
- The dump holds canonical recordings only. A live version with the same title as the studio one is folded into it.
- The dump supplies artist credit names. Artist aliases are absent.

## How search works

`searchCatalogIndex(query, { kinds, limit })` in `search.ts` returns up to `limit` results of each kind with a relevance score. `isCatalogIndexReady()` says whether an index is in place. Both the query and the names are compared as `matchKey`s, so case, punctuation and diacritics never matter ("beyonce" finds Beyoncé).

Indexed lookups gather candidates before ranking.

1. **Fuzzy, over the popular head.** The 250,000 most popular artists, the 250,000 most popular albums and the 1,000,000 most popular recordings carry a trigram index. A trigram word-similarity match tolerates typos ("beatels") and matches any word from its first few letters ("bohe"). Because the head has a fixed size, this costs the same whatever the size of the dump. Rows are stored in popularity order and read through a bitmap scan, which returns them in that order, so the 300 candidates taken are the most popular matches.
2. **Exact prefix, over everything.** A btree over every name finds the rows whose whole name starts with the query, so typing an obscure title in full always finds it.
3. **Composite readings, over everything.** The query splits into title and context, in either order. A context can be the artist credit or, for a recording, its release title. A btree finds title prefixes within each matching context. “Karma Police OK Computer” can find the track even if it is outside the fuzzy head.

Candidates are ranked by text quality (word similarity, plus bonuses when a word starts with the query and when the name is the query, ignoring a leading "the"), scaled by popularity. A famous near match beats an obscure one; an exact name beats a fuzzy one of similar fame.

Queries with non-ASCII characters use a GIN index of character bigrams for fuzzy candidates. This works under PostgreSQL's `C` locale, where `pg_trgm` can omit entire scripts. The bigrams fold katakana to hiragana and recompose Hangul syllables. ASCII queries keep the trigram path. The database migration adds the new indexes to the active dump, and future imports build them before swapping in the new table.

### Why this design

Measured on synthetic dumps of 5 and 10 million rows shaped like the real one (real vocabulary and name lengths from the first 161,607 rows of the 17 November dump, a power-law number of recordings per artist, 10% shared credits), with Postgres 17 at default settings (128 MB shared buffers) on an Apple-silicon laptop. Latencies are warm, for one call searching all three kinds, over about 20 queries of 1 to 16 characters:

| Approach | Slice | p50 | Worst | Notes |
|---|---|---|---|---|
| Trigram index over every row, rank all matches | 5 M | | 2.6 s | `love` alone: 33,000 matching recordings to rank, cold |
| Same index, first 300 matches in popularity order | 5 M | 35 ms | 112 ms | Grows with the dump (posting lists of common trigrams): 200 to 450 ms expected at full size |
| **Head trigram index plus prefix btree (chosen)** | 10 M | **10.5 ms** | **48 ms** | p95 45 ms. The head has a fixed size, so this holds at full size |

The prefix btree costs 36 bytes per row and answers in under a millisecond; a trigram index over every row would cost 46 bytes per row and still be slow for common words. The trade-off is that typo tolerance covers only the head. Typos in names outside the 1.5 million most popular entries are not corrected; such names are found by typing their start correctly.

Names are stored as `name_key` (the `matchKey` of the name) rather than relying on `unaccent` or `lower` in SQL, so matching uses the same normalization as the rest of Squirmy, needs no extra extension, and the indexes stay plain.

## Costs

| | 10 M row slice (measured) | Full dump (estimated) |
|---|---|---|
| Download | 0.9 GB | 2.4 GB |
| Final disk (table and indexes) | 2.1 GB | about 7 GB |
| Peak extra disk during an import | 5.8 GB | about 20 GB, on top of the index already in place |
| Downloaded dump kept while importing | 0.9 GB | 2.4 GB, in the data folder, deleted when the import ends |
| Import time, laptop with NVMe | 1 min 50 s | 7 to 10 minutes plus download time |
| Importer process memory | 250 MB peak resident | the same: everything is streamed, nothing grows with the dump |

Rows cost about 136 bytes each in the table, plus 36 bytes in the prefix index; the head indexes are about 80 MB in total whatever the dump size. The peak comes from the unlogged staging tables holding the raw rows while the new table is sorted and written; the staging tables are dropped before the indexes are built, and the old index is only dropped at the swap. A downloaded dump is also written to `<data folder>/catalog-index/<import id>.tar.zst` as it streams, so an import a restart stops does not download it again (see [Restarts](#restarts)); a dump read from a path on the server is not copied.

Expect a modest server (a few cores, SATA disk) to take three to five times longer: plan on 30 to 60 minutes. The import runs as a background job at low priority. Postgres does most of the work: in the 10 M run the Node process used 33 s of CPU out of 114 s, so decompression and parsing keep up with a download of about 25 MB/s. It raises `maintenance_work_mem` to 256 MB for its own connection while building indexes.

### The size knob

`recordingsPerArtist` keeps at most that many recordings per artist credit, best first (in canonical order, so studio albums before live tapes). Artists and albums are always complete. On the synthetic slice, 100 per artist removed 4% of the recordings and 25 removed 16%; on the real dump, where the biggest artists have thousands of recordings (the Beatles about 17,000), the saving is larger. The head, and so fuzzy search for famous music, is unaffected.

## Running it

Everything is behind admin routes under `/api/v1`:

| Route | What it does |
|---|---|
| `GET /admin/catalog-index` | `CatalogIndexStatus`: ready, dump date, row counts, size on disk, the active import and the newest other import with its phase, progress and how often it was resumed (`resumes`, `resumedAt`) |
| `POST /admin/catalog-index/import` | Queues the `catalog-index.import` job and answers 202. Body (all optional): `source`, a dump URL or a path on the server (default: the newest dump); `recordingsPerArtist` |
| `DELETE /admin/catalog-index/import` | Cancels the running or interrupted import; the index in use stays. 409 when there is none |
| `DELETE /admin/catalog-index` | Cancels a running import and empties the index |

```sh
curl -X POST https://music.example.com/api/v1/admin/catalog-index/import \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{}'
```

- **Refreshing.** Run the import again. Search keeps answering from the current index until the new one is complete; the swap is a rename in a single short transaction.
- **Failures.** A failed or cancelled import leaves the current index untouched and drops its staging tables and its downloaded dump. The status shows the error. A new import starts from the beginning. Only an admin's cancel ends an import as `cancelled`; a restart does not (below).
- **Offline or slow links.** Download the `.tar.zst` yourself (check it against the `.sha256` file next to it) and pass its path as `source`.
- **One at a time.** A second import while one runs, or while one waits to resume, is refused with 409.
- **zstd.** Node 22.15 and newer decompress zstd natively. On older Node the importer pipes through the `zstd` program and says so if it is missing.

### Restarts

A deploy, an upgrade or a crash does not lose an import: it carries on from its last checkpoint when a worker is running again, and nobody has to start it again.

- **Checkpoints.** Loading commits every million CSV rows, and each step of the build (one SQL statement: a derived table, an insert, an index) commits on its own. Each commit records the checkpoint in the same transaction (`catalog_index_imports.checkpoint`), so the two always agree. The checkpoint lists every staging table that exists at that point with the rows it holds, counted as the import writes them. A restart loses at most the chunk or the statement in progress.
- **Shutting down.** On SIGTERM the import cancels its statement, rolls back the open chunk, keeps its staging tables and downloaded dump, marks itself `interrupted` and queues the job that resumes it, all within a second or two. The server then stops within 20 seconds; give the container at least 30 to stop (`stop_grace_period: 30s` in `compose.yaml`; Coolify waits 30 seconds by default). A rolling deploy's new container takes the job up once the old one has stopped.
- **Resuming.** The resumed run reads the downloaded part of the dump back from disk and asks MetaBrainz only for the rest (an HTTP range request; a server that ignores ranges sends the whole file again, and the import skips what it has). The archive is a single zstd stream, so it is decompressed and parsed from the start each time, but rows already loaded are skipped rather than loaded again; a build that was under way carries on from the statement it stopped at without reading the dump at all. Admin → Search index says **Waiting to resume** in the meantime, and **Resumed after a restart** (or after *n* restarts) on the import while it runs and on the index once it is in place.
- **Crashes.** A worker killed without warning (out of memory, SIGKILL, power loss) cannot record anything. Its import is still marked running, but no process holds the import lock, so it is marked `interrupted` and resumed from its last checkpoint when a worker starts, when an admin starts or cancels an import, and within a minute otherwise (`catalog-index.recover`).
- **Postgres restarts.** Most staging tables are unlogged: a clean restart of Postgres keeps them, and crash recovery empties them. A deploy that recreates the Postgres container stops it cleanly, so the import carries on as after any other restart (on Coolify, [run the database separately](./server/coolify.md) so deploys do not restart it at all). Before trusting a checkpoint, a resumed import checks that each staging table it lists exists and holds exactly that many rows (one count per table, a few seconds on a full dump). If one does not (after a crash, a restore from a backup, a table dropped by hand), the import starts again from the beginning, keeping the downloaded dump. It does the same, once, if a table turns out to be missing later.
- **Giving up.** An import resumed six times in a row from the same checkpoint (one that runs the server out of memory at the same statement, say) is marked failed and its staging tables are dropped.
- **Cancelling.** Cancelling an interrupted import ends it at once and drops what it left behind.
