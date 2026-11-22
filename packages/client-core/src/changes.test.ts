import { EntityChanges, queryKeys, type EntityChange } from '@squirmy/contracts'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { coverKeys, patchEntities, planChanges, RealtimeBatch } from './changes.js'

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

describe('patchEntities', () => {
  const results = {
    tracks: [
      { id: uuid(1), title: 'One', availability: 'on_demand', album: { id: uuid(9), title: 'A' } },
      { id: uuid(2), title: 'Two', availability: 'on_demand', album: null },
    ],
    albums: [{ id: uuid(9), title: 'A', availability: 'on_demand', ownedTrackCount: 0 }],
  }

  it('sets fields an object carries, in place, without moving anything', () => {
    const next = patchEntities(results, new Map([
      [uuid(2), { availability: 'none' }],
      [uuid(9), { availability: 'partial', ownedTrackCount: 1 }],
    ]))
    expect(next.tracks.map((track) => [track.id, track.availability])).toEqual([[uuid(1), 'on_demand'], [uuid(2), 'none']])
    expect(next.albums[0]).toMatchObject({ availability: 'partial', ownedTrackCount: 1 })
    // An album reference carries no availability, so it is left alone.
    expect(next.tracks[0]!.album).toBe(results.tracks[0]!.album)
    expect(next.tracks[0]).toBe(results.tracks[0])
  })

  it('returns the same data when nothing matched or nothing changed', () => {
    expect(patchEntities(results, new Map([[uuid(5), { availability: 'none' }]]))).toBe(results)
    expect(patchEntities(results, new Map([[uuid(1), { availability: 'on_demand' }]]))).toBe(results)
    expect(patchEntities(results, new Map())).toBe(results)
  })
})

describe('planChanges', () => {
  it('merges availability and patches by id, later values winning', () => {
    const changes: EntityChange[] = [
      { kind: 'availability', tracks: [{ id: uuid(1), availability: 'server' }], albums: [{ id: uuid(9), availability: 'full', trackCount: 1, ownedTrackCount: 1 }] },
      { kind: 'patch', entity: 'track', id: uuid(1), fields: { liked: true } },
      { kind: 'availability', tracks: [{ id: uuid(1), availability: 'none' }], albums: [] },
    ]
    const plan = planChanges(changes)
    expect(plan.patches.get(uuid(1))).toEqual({ availability: 'none', liked: true })
    expect(plan.patches.get(uuid(9))).toEqual({ availability: 'full', trackCount: 1, ownedTrackCount: 1 })
    expect(plan.fields).toEqual([{ entity: 'track', id: uuid(1), fields: { liked: true } }])
    expect(plan.refetch).toEqual([])
  })

  it('refetches updated pages and gives up deleted ones', () => {
    const plan = planChanges([
      { kind: 'updated', entity: 'album', ids: [uuid(9), uuid(9)] },
      { kind: 'updated', entity: 'playlist', ids: [uuid(3)] },
      { kind: 'deleted', entity: 'playlist', ids: [uuid(3)] },
    ])
    expect(plan.refetch).toEqual([queryKeys.album(uuid(9))])
    expect(plan.gone).toEqual([queryKeys.playlist(uuid(3))])
  })

  it('parses what the server sends', () => {
    expect(EntityChanges.parse({ changes: [{ kind: 'deleted', entity: 'playlist', ids: [uuid(3)] }] }).changes).toHaveLength(1)
  })
})

describe('coverKeys', () => {
  it('drops repeats and keys a shorter one covers', () => {
    expect(coverKeys([['library', 'albums'], ['home'], ['library'], ['home'], ['album', 'x']]))
      .toEqual([['home'], ['library'], ['album', 'x']])
  })
})

describe('RealtimeBatch', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('hands a burst over once', () => {
    const flush = vi.fn()
    const batch = new RealtimeBatch(flush, 100)
    for (let n = 0; n < 20; n++) {
      batch.invalidate([['library'], ['album', uuid(n)]])
      batch.change([{ kind: 'availability', tracks: [{ id: uuid(n), availability: 'server' }], albums: [] }])
    }
    expect(flush).not.toHaveBeenCalled()
    vi.advanceTimersByTime(100)
    expect(flush).toHaveBeenCalledTimes(1)
    const [{ keys, changes }] = flush.mock.calls[0]!
    expect(keys.get('refetch')).toHaveLength(21)
    expect(changes).toHaveLength(20)
    vi.advanceTimersByTime(1000)
    expect(flush).toHaveBeenCalledTimes(1)
  })
})
