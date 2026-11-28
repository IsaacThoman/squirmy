import type { AlbumSummary, ArtistSummary, PlaylistSummary, SearchRanked, SearchResults, SearchTopResult, TrackAvailability, TrackSummary } from '@squirmy/contracts'
import { describe, expect, it } from 'vitest'
import type { Viewer } from './availability.js'
import { addRecentSearch, parseRecentSearches, RECENT_SEARCH_LIMIT, removeRecentSearch } from './recent-searches.js'
import { continuesQuery, keepOrder, mergeSearch, playlistScore, searchItemKey, tooShortToSearch, type SearchItem } from './search.js'

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
    expect(mergeSearch(null, undefined, fetcher)).toEqual({ items: [], lyricItems: [], top: null, artists: [], albums: [], tracks: [] })
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

  describe('the ranked list', () => {
    const rank = (type: SearchRanked['type'], n: number, score: number): SearchRanked => ({ type, id: uuid(n), score })
    const keys = (items: readonly SearchItem[]) => items.map(item => searchItemKey(item).replace(/:0+-0+-4000-8000-0*/, ':'))

    it('mixes kinds by score across both answers, an item named twice at its best', () => {
      const library = results({ albums: [album(10)], tracks: [track(20)], ranked: [rank('album', 10, 0.5), rank('track', 20, 0.4)] })
      const catalog = results({
        artists: [artist(1)], tracks: [track(21)],
        // The catalog also scores the library's album, higher: the provider knows it is popular.
        ranked: [rank('artist', 1, 0.6), rank('album', 10, 0.9), rank('track', 21, 0.45), rank('track', 99, 1)],
      })
      expect(keys(mergeSearch(library, catalog, fetcher).items)).toEqual(['album:10', 'artist:1', 'track:21', 'track:20'])
      // The library alone shows in its own ranking.
      expect(keys(mergeSearch(library, null, fetcher).items)).toEqual(['album:10', 'track:20'])
    })

    it('scores down what the viewer cannot play', () => {
      const catalog = results({ tracks: [track(1, 'none'), track(2, 'server')], ranked: [rank('track', 1, 0.8), rank('track', 2, 0.6)] })
      expect(keys(mergeSearch(null, catalog, member).items)).toEqual(['track:2', 'track:1'])
      expect(keys(mergeSearch(null, results({ ...catalog, ranked: [rank('track', 1, 0.95), rank('track', 2, 0.6)] }), member).items)).toEqual(['track:1', 'track:2'])
    })

    it('orders an older server\'s answers by how well names match what was typed, the top result first', () => {
      const catalog = results({
        artists: [{ ...artist(1), name: 'Bluebird' }, { ...artist(2), name: 'Blue' }],
        albums: [{ ...album(10), title: 'Something', artistCredit: 'Blue' }],
        tracks: [{ ...track(20), title: 'Blue Moon' }],
        top: top('artist', 1, 1),
      })
      expect(keys(mergeSearch(null, catalog, fetcher, { query: 'blue' }).items)).toEqual(['artist:1', 'artist:2', 'track:20', 'album:10'])
    })

    it('lists what an older server did not rank after, the top result first', () => {
      const catalog = results({ artists: [artist(1)], albums: [album(10)], tracks: [track(20)], top: top('track', 20, 3) })
      expect(keys(mergeSearch(null, catalog, fetcher).items)).toEqual(['track:20', 'artist:1', 'album:10'])
    })

    it('lists identical albums and songs under different ids once', () => {
      const copy = { ...album(11), title: 'Album 10' }
      const library = results({ albums: [album(10)], tracks: [{ ...track(20), durationMs: 200_000 }] })
      const catalog = results({
        albums: [copy, { ...album(12), title: 'Album 10', year: 2001 }],
        tracks: [{ ...track(21), title: 'Track 20', durationMs: 201_000 }, { ...track(22), title: 'Track 20', durationMs: 260_000 }],
        ranked: [rank('album', 11, 1), rank('album', 12, 0.9), rank('track', 21, 0.8), rank('track', 22, 0.7)],
      })
      const merged = mergeSearch(library, catalog, fetcher)
      // Another year is another album (a band's self-titled records); another length is another recording.
      expect(ids(merged.albums)).toEqual([10, 12])
      expect(ids(merged.tracks)).toEqual([20, 22])
      expect(keys(merged.items)).toEqual(['album:12', 'track:22', 'album:10', 'track:20'])
    })

    it('lists the viewer\'s playlists whose name matches', () => {
      const playlist = (n: number, name: string): PlaylistSummary => ({
        id: uuid(n), name, description: null, ownerId: uuid(0), ownerName: 'me', isPublic: false, trackCount: 3, durationMs: 1, artworks: [], updatedAt: '2026-01-01T00:00:00.000Z',
      })
      const catalog = results({ artists: [artist(1)], ranked: [rank('artist', 1, 0.5)] })
      const merged = mergeSearch(null, catalog, fetcher, { playlists: { query: 'road', items: [playlist(40, 'Road Trip'), playlist(41, 'Gym'), playlist(42, 'Night Road')] } })
      expect(keys(merged.items)).toEqual(['playlist:40', 'artist:1', 'playlist:42'])
      expect(playlistScore('Café', 'cafe')).toBeGreaterThan(playlistScore('caf', 'cafe'))
      expect(playlistScore('caf', 'cafe')).toBeGreaterThan(0)
      expect(playlistScore('xyz', 'cafe')).toBe(0)
    })
  })
})

describe('recently viewed search results', () => {
  it('keeps the newest first, once each, up to the limit', () => {
    let list = addRecentSearch([], { type: 'artist', artist: artist(1) })
    list = addRecentSearch(list, { type: 'track', track: track(2) })
    list = addRecentSearch(list, { type: 'artist', artist: artist(1) })
    expect(list.map(searchItemKey)).toEqual([`artist:${uuid(1)}`, `track:${uuid(2)}`])
    for (let n = 3; n <= 30; n++) list = addRecentSearch(list, { type: 'track', track: track(n) })
    expect(list).toHaveLength(RECENT_SEARCH_LIMIT)
    expect(removeRecentSearch(list, `track:${uuid(30)}`)[0]).toEqual({ type: 'track', track: track(29) })
  })

  it('keeps valid results from existing history and skips queries and invalid entries', () => {
    const stored = JSON.stringify([{ type: 'query', query: 'mgmt' }, { type: 'album', album: { id: 'not an album' } }, { type: 'track', track: track(5) }])
    expect(parseRecentSearches(stored)).toEqual([{ type: 'track', track: track(5) }])
    expect(parseRecentSearches('{')).toEqual([])
    expect(parseRecentSearches('{"a":1}')).toEqual([])
    expect(parseRecentSearches(null)).toEqual([])
  })
})

describe('keepOrder', () => {
  const items = (...ns: number[]): SearchItem[] => ns.map(n => ({ type: 'track', track: track(n) }))
  const keys = (list: readonly SearchItem[]) => list.map(item => Number(searchItemKey(item).slice(-12)))

  it('keeps rows already shown where they were and adds new ones after them', () => {
    const first = keepOrder(items(1, 2, 3), null)
    expect(keys(first.items)).toEqual([1, 2, 3])
    const again = keepOrder(items(3, 4, 1, 2), first.order)
    expect(keys(again.items)).toEqual([1, 2, 3, 4])
    expect(again.order).toEqual(again.items.map(searchItemKey))
  })
})

describe('query helpers', () => {
  it('lets results stand in only for the same search typed on or deleted back', () => {
    expect(continuesQuery('tame impala', 'tame')).toBe(true)
    expect(continuesQuery('Tam', 'tame impala')).toBe(true)
    expect(continuesQuery('mi', 'tame impala')).toBe(false)
    expect(continuesQuery('', 'tame')).toBe(false)
  })

  it('says a single letter is too short, but not a symbol-only name', () => {
    expect(tooShortToSearch('a')).toBe(true)
    expect(tooShortToSearch(' é ')).toBe(true)
    expect(tooShortToSearch('ab')).toBe(false)
    expect(tooShortToSearch('!!!')).toBe(false)
  })
})

