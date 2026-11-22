/**
 * Seam between the catalog read side and enrichment.
 *
 * Catalog rows start as stubs (`detail_level` 0 or 1) and are completed on demand: the
 * artist and album routes call these before reading. Each waits a few seconds at most
 * and never throws: when sources are slow or down the page renders what is known. A run
 * still going when the budget ends carries on in this process, and a delayed job is
 * queued as a safety net in case the process stops first (it finds the row complete and
 * does nothing otherwise). Concurrent callers for one row share one run.
 */
import { queryKeys } from '@squirmy/contracts'
import { enqueue } from '../../jobs/index.js'
import { hydrateAlbum } from './album.js'
import { hydrateArtist } from './artist.js'
import { fitStrayRecordingsNow } from './fit.js'
import { fetchLyrics } from './lyrics.js'
import { changed } from './rows.js'
import { onBudget, shared, warn } from './runner.js'

/** Seconds before the safety-net job starts, so it does not race the run it backs up. */
const safetyNetDelaySec = 60

/**
 * Waits for the run of `key` within the budget; when it is not done, queues `job` for `id`
 * as the safety net. Returns whether the page shows the run's final result.
 */
async function onPage(key: string, work: (usable: () => void) => Promise<void>, job: string, id: string, data: object): Promise<boolean> {
  const outcome = await onBudget(key, work, job)
  if (outcome === 'done') return true
  await enqueue(job, data, { singletonKey: id, startAfter: safetyNetDelaySec, priority: -5 })
    .catch((error: unknown) => warn(`Could not queue ${job}`, error))
  return false
}

const albumWork = (albumId: string) => async (usable: () => void) => {
  const result = await hydrateAlbum(albumId, { usable })
  // A file filed under an album that is already complete (a fetched track) may still be
  // on a stand-in recording; folding it in needs no provider.
  if (result && (await fitStrayRecordingsNow(result)) > 0) await changed([queryKeys.album(result)])
}

const artistWork = (artistId: string) => async () => {
  await hydrateArtist(artistId)
}

/** The shared run that completes an album's detail; jobs and pages use the same one. */
export function albumDetailRun(albumId: string): Promise<void> {
  return shared(`album:${albumId}`, albumWork(albumId))
}

/** The shared run that completes an artist's detail. */
export function artistDetailRun(artistId: string): Promise<void> {
  return shared(`artist:${artistId}`, artistWork(artistId))
}

/**
 * Fetch an album's canonical edition and track list if they are missing or stale.
 * Resolves false when the page renders before the run is done (it then shows what is
 * known, and clients refetch on the invalidation the run sends when it lands).
 */
export async function ensureAlbumDetail(albumId: string): Promise<boolean> {
  return onPage(`album:${albumId}`, albumWork(albumId), 'enrichment.album', albumId, { albumId })
}

/** Fetch an artist's profile and discography if they are missing or stale. Resolves like `ensureAlbumDetail`. */
export async function ensureArtistDetail(artistId: string): Promise<boolean> {
  return onPage(`artist:${artistId}`, artistWork(artistId), 'enrichment.artist', artistId, { artistId })
}

/** The shared run that looks a recording's lyrics up. */
export function lyricsRun(recordingId: string): Promise<void> {
  return shared(`lyrics:${recordingId}`, () => fetchLyrics(recordingId))
}

/** Look a track's lyrics up once when it has no lyrics row yet. */
export async function ensureLyrics(recordingId: string): Promise<void> {
  await onPage(`lyrics:${recordingId}`, () => fetchLyrics(recordingId), 'enrichment.lyrics', recordingId, { recordingId })
}
