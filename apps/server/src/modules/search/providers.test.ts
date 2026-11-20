import { describe, expect, it, vi } from 'vitest'
import { ProviderError } from '../../lib/http.js'
import { searchCatalog, type ProviderResults, type SearchProvider } from './providers.js'

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
})
