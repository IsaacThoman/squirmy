import type { AlbumSummary, ArtistSummary, SearchResults, SearchTopResult, TrackAvailability, TrackSummary } from '@squirmy/contracts'
import { describe, expect, it } from 'vitest'
import type { Viewer } from './availability.js'
import { mergeSearch } from './search.js'

const fetcher: Viewer = { role: 'member', canAcquire: true }
const member: Viewer = { role: 'member', canAcquire: false }

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const artist = (n: number): ArtistSummary => ({ id: uuid(n), mbid: null, name: `Artist ${n}`, image: null, inLibrary: false })
const album = (n: number, availability: AlbumSummary['availability'] = 'full'): AlbumSummary => ({
  id: uuid(n), mbid: null, title: `Album ${n}`, artistCredit: 'A', artists: [], year: null, type: 'album', artwork: null,
  availability, trackCount: 1, ownedTrackCount: availability === 'full' ? 1 : 0,
})
const track = (n: number, availability: TrackAvailability = 'server'): TrackSummary => ({
  id: uuid(n), mbid: null, title: `Track ${n}`, artistCredit: 'A', artists: [], durationMs: 1000, album: null,
  disc: null, position: null, availability, liked: false, explicit: null, hasLyrics: false,
})
const results = (parts: Partial<SearchResults>): SearchResults => ({ artists: [], albums: [], tracks: [], provider: null, ...parts })
const ids = (items: readonly { id: string }[]) => items.map(item => Number(item.id.slice(-12)))
const top = (type: SearchTopResult['type'], n: number, score?: number): SearchTopResult => ({ type, id: uuid(n), ...(score ? { score } : {}) })

describe('mergeSearch', () => {
  it('is empty while both answers load, and shows the library alone first', () => {
    expect(mergeSearch(null, undefined, fetcher)).toEqual({ top: null, artists: [], albums: [], tracks: [] })
    const library = results({ tracks: [track(2), track(1)], top: top('track', 1, 3) })
    const merged = mergeSearch(library, null, fetcher)
    expect(ids(merged.tracks)).toEqual([2, 1])
    expect(merged.top).toEqual({ type: 'track', track: track(1) })
  })

  it('keeps library order, appends the catalog and drops ids already listed', () => {
    const library = results({ artists: [artist(1)], albums: [album(11), album(10)], tracks: [track(21), track(20)] })
    const catalog = results({ artists: [artist(2), artist(1)], albums: [album(10), album(12)], tracks: [track(22), track(21), track(23)] })
    const before = mergeSearch(library, null, fetcher)
    const after = mergeSearch(library, catalog, fetcher)
    expect(ids(after.artists)).toEqual([1, 2])
    expect(ids(after.albums)).toEqual([11, 10, 12])
    expect(ids(after.tracks)).toEqual([21, 20, 22, 23])
    // Rows already on screen stay where they were.
    expect(ids(after.tracks).slice(0, before.tracks.length)).toEqual(ids(before.tracks))
    expect(ids(after.albums).slice(0, before.albums.length)).toEqual(ids(before.albums))
  })

  it('lists what the viewer cannot play after what they can, within the catalog part of each kind', () => {
    const library = results({ tracks: [track(1, 'server')] })
    const catalog = results({
      albums: [album(10, 'none'), album(11, 'on_demand'), album(12, 'partial')],
      tracks: [track(2, 'none'), track(3, 'on_demand'), track(4, 'server'), track(5, 'on_demand')],
    })
    const forFetcher = mergeSearch(library, catalog, fetcher)
    expect(ids(forFetcher.tracks)).toEqual([1, 3, 4, 5, 2])
    expect(ids(forFetcher.albums)).toEqual([11, 12, 10])
    const forMember = mergeSearch(library, catalog, member)
    expect(ids(forMember.tracks)).toEqual([1, 4, 2, 3, 5])
    expect(ids(forMember.albums)).toEqual([12, 10, 11])
  })

  it('never moves library rows, even unavailable ones', () => {
    const library = results({ tracks: [track(1, 'none'), track(2, 'server')] })
    expect(ids(mergeSearch(library, results({ tracks: [track(3)] }), member).tracks)).toEqual([1, 2, 3])
  })

  describe('top result', () => {
    const library = results({ artists: [artist(1)], albums: [album(10)] })
    const catalog = results({ artists: [artist(2)], albums: [album(11)] })

    it('takes the higher score', () => {
      const merged = mergeSearch({ ...library, top: top('artist', 1, 1) }, { ...catalog, top: top('album', 11, 3) }, fetcher)
      expect(merged.top).toEqual({ type: 'album', album: album(11) })
      const kept = mergeSearch({ ...library, top: top('artist', 1, 3) }, { ...catalog, top: top('album', 11, 2) }, fetcher)
      expect(kept.top).toEqual({ type: 'artist', artist: artist(1) })
    })

    it('keeps the library hint on a tie', () => {
      const merged = mergeSearch({ ...library, top: top('album', 10, 2) }, { ...catalog, top: top('artist', 2, 2) }, fetcher)
      expect(merged.top).toEqual({ type: 'album', album: album(10) })
    })

    it('without scores, as from an older server, prefers the library hint, else the catalog one', () => {
      expect(mergeSearch({ ...library, top: top('artist', 1) }, { ...catalog, top: top('artist', 2) }, fetcher).top)
        .toEqual({ type: 'artist', artist: artist(1) })
      expect(mergeSearch({ ...library, top: top('artist', 1) }, { ...catalog, top: top('artist', 2, 3) }, fetcher).top)
        .toEqual({ type: 'artist', artist: artist(1) })
      expect(mergeSearch({ ...library, top: null }, { ...catalog, top: top('artist', 2) }, fetcher).top)
        .toEqual({ type: 'artist', artist: artist(2) })
    })

    it('ignores a hint that names nothing in the lists', () => {
      expect(mergeSearch({ ...library, top: top('track', 99, 3) }, { ...catalog, top: top('album', 11, 1) }, fetcher).top)
        .toEqual({ type: 'album', album: album(11) })
      expect(mergeSearch({ ...library, top: top('track', 99, 3) }, null, fetcher).top).toBeNull()
    })

    it('finds a catalog hint that names an item the library already listed', () => {
      const merged = mergeSearch(library, { ...catalog, artists: [artist(1)], top: top('artist', 1, 3) }, fetcher)
      expect(merged.top).toEqual({ type: 'artist', artist: artist(1) })
      expect(ids(merged.artists)).toEqual([1])
    })
  })
})
