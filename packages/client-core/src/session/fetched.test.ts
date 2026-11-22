import type { QueueEntry } from '@squirmy/contracts'
import { describe, expect, it, vi } from 'vitest'
import { refreshFetchedTracks } from './fetched.js'
import { createInitialSession, splitSession } from './reducer.js'

const track = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const entry = (n: number, state: QueueEntry['state']): QueueEntry => ({ id: `e.${n}`, trackId: track(n), albumId: track(90), durationMs: 1000, state })

function fakeClient(current: QueueEntry | null, queue: QueueEntry[] = []) {
  const listeners = new Set<() => void>()
  const of = (now: QueueEntry | null, rest: QueueEntry[]) => {
    const { state, queue: half } = splitSession({ ...createInitialSession(), current: now, queue: rest })
    return { session: state, queue: half }
  }
  let snapshot = of(current, queue)
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    set(next: QueueEntry | null, nextQueue: QueueEntry[] = []) {
      snapshot = of(next, nextQueue)
      for (const listener of listeners) listener()
    },
  }
}

describe('refreshFetchedTracks', () => {
  it('refreshes each entry the server fetched once, current or queued, and stops when asked', () => {
    const client = fakeClient(entry(1, 'preparing'), [entry(2, 'preparing'), entry(3, 'ready')])
    const store = { refresh: vi.fn() }
    const stop = refreshFetchedTracks(client, store)
    client.set(entry(1, 'ready'), [entry(2, 'preparing'), entry(3, 'ready')])
    expect(store.refresh.mock.calls).toEqual([[track(1), track(90)]])
    client.set(entry(1, 'ready'), [entry(2, 'ready'), entry(3, 'ready')])
    expect(store.refresh.mock.calls).toEqual([[track(1), track(90)], [track(2), track(90)]])
    // A failed fetch has nothing new to read.
    stop()
    client.set(entry(4, 'ready'))
    expect(store.refresh).toHaveBeenCalledTimes(2)
  })
})
