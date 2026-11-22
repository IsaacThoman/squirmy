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
import { getConfig } from '../../config.js'
import { enqueue } from '../../jobs/index.js'
import { hydrateAlbum } from './album.js'
import { hydrateArtist } from './artist.js'
import { fetchLyrics } from './lyrics.js'
import { shared, warn, withinBudget } from './runner.js'

/** Seconds before the safety-net job starts, so it does not race the run it backs up. */
const safetyNetDelaySec = 60

/** Waits for `run` within the budget; when it is still going, queues `job` for `id` as the safety net. */
async function onPage(run: Promise<void>, job: string, id: string, data: object) {
  if (await withinBudget(run, job)) return
  await enqueue(job, data, { singletonKey: id, startAfter: safetyNetDelaySec, priority: -5 })
    .catch((error: unknown) => warn(`Could not queue ${job}`, error))
}

/** The shared run that completes an album's detail; jobs and pages use the same one. */
export function albumDetailRun(albumId: string): Promise<void> {
  return shared(`album:${albumId}`, async () => {
    await hydrateAlbum(albumId)
  })
}

/** The shared run that completes an artist's detail. */
export function artistDetailRun(artistId: string): Promise<void> {
  return shared(`artist:${artistId}`, async () => {
    await hydrateArtist(artistId)
  })
}

/** Fetch an album's canonical edition and track list if they are missing or stale. */
export async function ensureAlbumDetail(albumId: string): Promise<void> {
  await onPage(albumDetailRun(albumId), 'enrichment.album', albumId, { albumId })
}

/** Fetch an artist's profile and discography if they are missing or stale. */
export async function ensureArtistDetail(artistId: string): Promise<void> {
  await onPage(artistDetailRun(artistId), 'enrichment.artist', artistId, { artistId })
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
  await onPage(lyricsRun(recordingId), 'enrichment.lyrics', recordingId, { recordingId })
}
