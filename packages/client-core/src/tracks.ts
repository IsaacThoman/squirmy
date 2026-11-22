import type { TrackSummariesRequest, TrackSummariesResponse, TrackSummary } from '@squirmy/contracts'
import { setTimer } from './timers.js'

/** The one API call the store needs; `api.catalog.trackSummaries` fits. */
export type FetchTrackSummaries = (request: TrackSummariesRequest) => Promise<TrackSummariesResponse>

/** Most tracks per `POST /tracks/summaries`, the contract's limit. */
const BATCH_LIMIT = 500

type Wanted = { id: string; albumId: string | null }

/**
 * Hydrates queue entries into `TrackSummary` objects. Summaries are cached by track id
 * and album id (the album decides artwork); misses are fetched in batches.
 *
 * Works with `useSyncExternalStore(store.subscribe, () => store.get(trackId, albumId))`:
 * `get` returns the same object until a newer summary for that key arrives.
 */
export class TrackStore {
  private readonly cache = new Map<string, TrackSummary>()
  /** Keys the server returned nothing for; never re-requested. */
  private readonly missing = new Set<string>()
  private readonly inFlight = new Set<string>()
  private readonly queued = new Map<string, Wanted>()
  /** In-flight keys refreshed meanwhile, fetched again when their answer is in. */
  private readonly again = new Set<string>()
  private readonly listeners = new Set<() => void>()
  private scheduled = false

  /**
   * @param fetchSummaries performs the request.
   * @param batchDelayMs how long to collect misses before one request goes out.
   */
  constructor(private readonly fetchSummaries: FetchTrackSummaries, private readonly batchDelayMs = 10) {}

  /**
   * The cached summary, or undefined. A miss schedules a batched fetch (never more than
   * one request per key at a time) and notifies subscribers when it arrives. Safe to
   * call during render: it never notifies synchronously. A failed fetch is retried by
   * the next `get` of that key.
   */
  get(trackId: string, albumId: string | null = null): TrackSummary | undefined {
    const key = keyOf(trackId, albumId)
    const summary = this.cache.get(key)
    if (summary || this.missing.has(key) || this.inFlight.has(key) || this.queued.has(key)) return summary
    this.queue(key, { id: trackId, albumId })
    return undefined
  }

  /** The cached summary, without fetching a missing one. */
  peek(trackId: string, albumId: string | null = null): TrackSummary | undefined {
    return this.cache.get(keyOf(trackId, albumId))
  }

  /**
   * Fetches the summary again, keeping the cached one until the answer arrives. For a track
   * whose details changed on the server: an on-demand track gains its album and cover once
   * its file is fetched, and the summary taken before then has neither.
   */
  refresh(trackId: string, albumId: string | null = null): void {
    const key = keyOf(trackId, albumId)
    this.missing.delete(key)
    if (this.queued.has(key)) return
    // The answer on its way may have been read before the change: ask again once it is in.
    if (this.inFlight.has(key)) {
      this.again.add(key)
      return
    }
    this.queue(key, { id: trackId, albumId })
  }

  /** `refresh` for every album the track is cached under: what an invalidation of the track asks for. */
  refreshTrack(trackId: string): void {
    const prefix = keyOf(trackId, null)
    const keys = new Set([...this.cache.keys(), ...this.missing].filter(key => key.startsWith(prefix)))
    for (const key of keys) this.refresh(trackId, key.slice(prefix.length) || null)
  }

  /**
   * Refreshes the tracks named by a realtime `invalidate` (`queryKeys.track`), which the
   * server sends when a track's details change: its file was fetched and filed on an album,
   * its cover arrived. Other keys are ignored.
   */
  refreshInvalidated(keys: readonly (readonly unknown[])[]): void {
    for (const key of keys) if (key.length === 2 && key[0] === 'track' && typeof key[1] === 'string') this.refreshTrack(key[1])
  }

  /** Adds summaries the caller already has (album pages, search results), keyed by their album. */
  prime(tracks: readonly TrackSummary[]): void {
    for (const track of tracks) this.cache.set(keyOf(track.id, track.album?.id ?? null), track)
    if (tracks.length) this.notify()
  }

  /** Calls `listener` whenever summaries arrive. Returns a function that unsubscribes. */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private queue(key: string, wanted: Wanted): void {
    this.queued.set(key, wanted)
    if (!this.scheduled) {
      this.scheduled = true
      setTimer(() => this.flush(), this.batchDelayMs)
    }
  }

  private flush(): void {
    this.scheduled = false
    const wanted = [...this.queued]
    this.queued.clear()
    for (let start = 0; start < wanted.length; start += BATCH_LIMIT) {
      void this.fetchBatch(wanted.slice(start, start + BATCH_LIMIT))
    }
  }

  private async fetchBatch(batch: [string, Wanted][]): Promise<void> {
    for (const [key] of batch) this.inFlight.add(key)
    try {
      const { tracks, requestedIds } = await this.fetchSummaries({ tracks: batch.map(([, wanted]) => wanted) })
      // A merged track comes back under the id it was merged into; `requestedIds` (newer
      // servers) names the id each summary answers, so it is filed under the one we hold.
      const answers = tracks.map((track, index) => ({ track, asked: requestedIds?.[index] ?? track.id }))
      for (const [key, wanted] of batch) {
        // The server may present a track in a different album than asked; fall back to any.
        const found = answers.find(({ track, asked }) => asked === wanted.id && (track.album?.id ?? null) === wanted.albumId)?.track
          ?? answers.find(({ asked }) => asked === wanted.id)?.track
        if (found) this.cache.set(key, found)
        else this.missing.add(key)
      }
      this.notify()
    } catch {
      // Left uncached so a later `get` retries.
    } finally {
      for (const [key, wanted] of batch) {
        this.inFlight.delete(key)
        if (this.again.delete(key)) this.queue(key, wanted)
      }
    }
  }

  private notify(): void {
    for (const listener of [...this.listeners]) listener()
  }
}

function keyOf(trackId: string, albumId: string | null): string {
  return `${trackId}:${albumId ?? ''}`
}
