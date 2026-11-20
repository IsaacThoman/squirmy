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
    this.queued.set(key, { id: trackId, albumId })
    if (!this.scheduled) {
      this.scheduled = true
      setTimer(() => this.flush(), this.batchDelayMs)
    }
    return undefined
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
      const { tracks } = await this.fetchSummaries({ tracks: batch.map(([, wanted]) => wanted) })
      for (const [key, wanted] of batch) {
        // The server may present a track in a different album than asked; fall back to any.
        const found = tracks.find(track => track.id === wanted.id && (track.album?.id ?? null) === wanted.albumId)
          ?? tracks.find(track => track.id === wanted.id)
        if (found) this.cache.set(key, found)
        else this.missing.add(key)
      }
      this.notify()
    } catch {
      // Left uncached so a later `get` retries.
    } finally {
      for (const [key] of batch) this.inFlight.delete(key)
    }
  }

  private notify(): void {
    for (const listener of [...this.listeners]) listener()
  }
}

function keyOf(trackId: string, albumId: string | null): string {
  return `${trackId}:${albumId ?? ''}`
}
