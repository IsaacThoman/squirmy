import type { TrackSummariesRequest, TrackSummary } from '@squirmy/contracts'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TrackStore } from './tracks.js'

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const summary = (n: number, albumId: string | null = null): TrackSummary => ({
  id: uuid(n),
  mbid: null,
  title: `Track ${n}`,
  artistCredit: 'Test',
  artists: [],
  durationMs: 1000,
  album: albumId ? { id: albumId, title: 'Album', artwork: null } : null,
  disc: null,
  position: null,
  availability: 'server',
  liked: false,
  explicit: null,
  hasLyrics: false,
})

function fakeApi(lookup: (request: TrackSummariesRequest) => TrackSummary[] = request =>
  request.tracks.map((track, index) => summary(Number(track.id.slice(-12)) || index, track.albumId ?? null))) {
  return vi.fn(async (request: TrackSummariesRequest) => ({ tracks: lookup(request) }))
}

describe('TrackStore', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('batches and de-duplicates misses, then notifies', async () => {
    const api = fakeApi()
    const store = new TrackStore(api)
    const listener = vi.fn()
    store.subscribe(listener)
    expect(store.get(uuid(1))).toBeUndefined()
    store.get(uuid(1))
    store.get(uuid(2), uuid(9))
    await vi.runAllTimersAsync()
    expect(api).toHaveBeenCalledOnce()
    expect(api.mock.calls[0]![0].tracks).toEqual([{ id: uuid(1), albumId: null }, { id: uuid(2), albumId: uuid(9) }])
    expect(listener).toHaveBeenCalledOnce()
    const first = store.get(uuid(1))
    expect(first?.title).toBe('Track 1')
    expect(store.get(uuid(1))).toBe(first)
    expect(store.get(uuid(2), uuid(9))?.album?.id).toBe(uuid(9))
  })

  it('caches by track and album', async () => {
    const api = fakeApi()
    const store = new TrackStore(api)
    store.get(uuid(1), uuid(8))
    await vi.runAllTimersAsync()
    store.get(uuid(1), uuid(9))
    await vi.runAllTimersAsync()
    expect(api).toHaveBeenCalledTimes(2)
  })

  it('splits requests at the contract limit', async () => {
    const api = fakeApi()
    const store = new TrackStore(api)
    for (let n = 1; n <= 501; n += 1) store.get(uuid(n))
    await vi.runAllTimersAsync()
    expect(api.mock.calls.map(([request]) => request.tracks.length)).toEqual([500, 1])
  })

  it('primes without fetching and falls back to any album the server chose', async () => {
    const api = fakeApi(() => [summary(3, uuid(7))])
    const store = new TrackStore(api)
    store.prime([summary(1, uuid(9))])
    expect(store.get(uuid(1), uuid(9))?.title).toBe('Track 1')
    store.get(uuid(3))
    await vi.runAllTimersAsync()
    expect(store.get(uuid(3))?.album?.id).toBe(uuid(7))
    expect(api).toHaveBeenCalledOnce()
  })

  it('does not re-request missing tracks but retries failures', async () => {
    const api = vi.fn(async () => ({ tracks: [] as TrackSummary[] }))
    const store = new TrackStore(api)
    store.get(uuid(1))
    await vi.runAllTimersAsync()
    store.get(uuid(1))
    await vi.runAllTimersAsync()
    expect(api).toHaveBeenCalledOnce()

    const failing = vi.fn(async () => { throw new Error('offline') })
    const retrying = new TrackStore(failing)
    retrying.get(uuid(2))
    await vi.runAllTimersAsync()
    retrying.get(uuid(2))
    await vi.runAllTimersAsync()
    expect(failing).toHaveBeenCalledTimes(2)
  })
})
