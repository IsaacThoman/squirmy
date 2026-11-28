import { describe, expect, it, vi } from 'vitest'
import { ProviderError } from '../../lib/http.js'
import { searchCatalog, type ProviderResults, type ProviderTrack, type SearchProvider } from './providers.js'

const empty: ProviderResults = { artists: [], albums: [], tracks: [] }

function fake(name: SearchProvider['name'], behaviour: { available?: boolean; fails?: boolean } = {}) {
  const provider: SearchProvider = {
    name,
    idSource: name === 'deezer' ? 'deezer' : 'musicbrainz',
    available: async () => behaviour.available ?? true,
    search: vi.fn(async () => {
      if (behaviour.fails) throw new ProviderError(name, 'down')
      await new Promise((resolve) => setTimeout(resolve, 10))
      return { ...empty, artists: [{ id: name, mbid: null, name, imageUrl: null }] }
    }),
  }
  return provider
}

describe('searchCatalog', () => {
  it('asks the first available provider', async () => {
    const providers = [fake('local-index', { available: false }), fake('deezer'), fake('musicbrainz')]
    const { provider, results } = await searchCatalog('radiohead', 5, providers)
    expect(provider?.name).toBe('deezer')
    expect(results.artists[0]!.name).toBe('deezer')
    expect(providers[0]!.search).not.toHaveBeenCalled()
    expect(providers[2]!.search).not.toHaveBeenCalled()
  })

  it('falls through to the next provider when one fails', async () => {
    const providers = [fake('local-index', { fails: true }), fake('deezer', { fails: true }), fake('musicbrainz')]
    expect((await searchCatalog('radiohead', 5, providers)).provider?.name).toBe('musicbrainz')
  })

  it('throws the last failure when every provider fails, and answers nothing when none is available', async () => {
    await expect(searchCatalog('radiohead', 5, [fake('deezer', { fails: true }), fake('musicbrainz', { fails: true })])).rejects.toThrow('musicbrainz: down')
    expect(await searchCatalog('radiohead', 5, [fake('deezer', { available: false })])).toEqual({ provider: null, results: empty })
  })

  it('shares one call between identical queries in flight, ignoring case and spacing', async () => {
    const deezer = fake('deezer')
    const [one, two, three] = await Promise.all([
      searchCatalog('Radiohead', 5, [deezer]), searchCatalog(' radiohead ', 5, [deezer]), searchCatalog('radiohead', 3, [deezer]),
    ])
    expect(one.results).toBe(two.results)
    expect(three.results).not.toBe(one.results)
    expect(deezer.search).toHaveBeenCalledTimes(2)
    await searchCatalog('radiohead', 5, [deezer])
    expect(deezer.search).toHaveBeenCalledTimes(3)
  })

  it.each(['radiohead karma police', 'karma police radiohead', 'karma police ok computer'])(
    'merges and deduplicates verified composite matches for %s', async (query) => {
      const track: ProviderTrack = {
        id: '1', mbid: null, title: 'Karma Police', artistCredit: 'Radiohead', artists: [],
        durationMs: null, explicit: null, popularity: null, isrcs: [],
        album: { id: '2', mbid: null, title: 'OK Computer', artistCredit: 'Radiohead', artists: [],
          type: 'album', year: 1997, releaseDate: null, artworkUrl: null },
      }
      const wrong = { ...track, id: '3', artistCredit: 'Other Artist', album: null }
      const whole = { ...wrong, id: '4' }
      const provider = {
        ...fake('deezer'),
        search: vi.fn(async () => ({ ...empty, tracks: [whole] })),
        composite: vi.fn(async () => ({ ...empty, tracks: [wrong, track, track] })),
      }
      const { results } = await searchCatalog(query, 5, [provider])
      expect(results.tracks).toEqual([track, whole])
      expect(provider.composite).toHaveBeenCalledWith(
        expect.arrayContaining([expect.objectContaining({ title: 'karma police' })]),
        expect.objectContaining({ types: ['album', 'track'] }),
      )
    },
  )

  it('keeps the original answer when a supplementary provider lookup fails', async () => {
    const provider = { ...fake('deezer'), composite: vi.fn(async () => { throw new Error('unavailable') }) }
    expect((await searchCatalog('missing song', 5, [provider])).results.artists).toHaveLength(1)
  })

  it('also asks without trailing edition words, the answer for the whole query first', async () => {
    const album = (id: string, title: string) => ({
      id, mbid: null, title, artistCredit: 'Radiohead', artists: [], type: 'album' as const, year: null, releaseDate: null, artworkUrl: null,
    })
    const deezer: SearchProvider = {
      name: 'deezer',
      idSource: 'deezer',
      available: async () => true,
      search: vi.fn(async (query: string) => (query === 'ok computer'
        ? { ...empty, albums: [album('1', 'OK Computer'), album('2', 'OK Computer OKNOTOK 1997 2017')] }
        : { ...empty, albums: [album('2', 'OK Computer OKNOTOK 1997 2017')] })),
    }
    const { results } = await searchCatalog('OK Computer Deluxe', 5, [deezer])
    expect(deezer.search).toHaveBeenCalledTimes(2)
    expect(results.albums.map((one) => one.id)).toEqual(['2', '1'])
    // Edition words that are the whole query, or words that only look like them, are searched as they are.
    for (const query of ['deluxe edition', 'taylor swift 1989 taylors version', 'clean bandit']) {
      vi.mocked(deezer.search).mockClear()
      await searchCatalog(query, 5, [deezer])
      expect(deezer.search).toHaveBeenCalledOnce()
    }
  })
})
