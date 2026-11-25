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
import { getConfig } from '../../config.js'
import { enqueue } from '../../jobs/index.js'
import { hydrateAlbum } from './album.js'
import { hydrateArtist } from './artist.js'
import { fitStrayFilesNow } from './fit.js'
import { fetchLyrics } from './lyrics.js'
import { queueEditionCheck } from './named-editions.js'
import { artistRadioRows } from './radio.js'
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
  // on a stand-in recording; folding it in needs no provider. Writing the release fits
  // stand-ins itself, so this only runs when such a file is there.
  if (result && (await fitStrayFilesNow(result)) > 0) await changed([queryKeys.album(result)])
  // Editions with a title of their own ("SO CLOSE TO WHAT???") become rows of their own.
  if (result) await queueEditionCheck(result)
}

const artistWork = (artistId: string) => async (usable: () => void) => {
  await hydrateArtist(artistId, { usable })
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

/** Background warm-ups at a time; more are skipped, so a burst of searches cannot queue up provider calls. */
const maxWarming = 2
const warming = new Set<string>()
let warmInTests = false

/** Tests turn warming on where they record the provider calls it makes. */
export function setDetailWarming(enabled: boolean) {
  warmInTests = enabled
}

/**
 * Starts completing an album's or artist's detail in the background, for the page a user
 * is likely to open next (a search's top result), so the page does not wait up to the
 * budget for providers. Joins a run already in flight; does nothing for a complete row,
 * as the run itself checks; never throws.
 */
export function warmDetail(type: 'album' | 'artist', id: string) {
  if (getConfig().NODE_ENV === 'test' && !warmInTests) return
  const key = `${type}:${id}`
  if (warming.has(key) || warming.size >= maxWarming) return
  warming.add(key)
  void (type === 'album' ? albumDetailRun(id) : artistDetailRun(id))
    .catch((error: unknown) => warn(`Warming ${key} failed`, error))
    .finally(() => warming.delete(key))
}

/** The shared run that looks a recording's lyrics up. */
export function lyricsRun(recordingId: string): Promise<void> {
  return shared(`lyrics:${recordingId}`, () => fetchLyrics(recordingId))
}

/** Look a track's lyrics up once when it has no lyrics row yet. */
export async function ensureLyrics(recordingId: string): Promise<void> {
  await onPage(`lyrics:${recordingId}`, () => fetchLyrics(recordingId), 'enrichment.lyrics', recordingId, { recordingId })
}

/**
 * The recordings Deezer's radio of the artist plays (a few of its own tracks and popular
 * ones by artists like it), in that order, as catalog rows: rows the catalog has, else
 * provider-only stubs (radio.ts). For the radio module's suggestions. Empty when Deezer
 * is off, does not know the artist, or fails; never throws. With `waitMs`, answers by then
 * with the rows written so far while the rest are written in the background.
 */
export async function artistRadioTracks(artistId: string, options: { waitMs?: number } = {}): Promise<string[]> {
  try {
    return await artistRadioRows(artistId, options)
  } catch (error) {
    warn(`Deezer radio of artist ${artistId} failed`, error)
    return []
  }
}
