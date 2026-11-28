import { describe, expect, it } from 'vitest'
import { SearchQuery, SearchResults } from './search.js'

const id = '00000000-0000-4000-8000-000000000001'
const empty = { artists: [], albums: [], tracks: [], provider: null }

describe('SearchResults.top', () => {
  it('reads hints with and without a score', () => {
    expect(SearchResults.parse({ ...empty, top: { type: 'album', id } }).top).toEqual({ type: 'album', id })
    expect(SearchResults.parse({ ...empty, top: { type: 'album', id, score: 3 } }).top?.score).toBe(3)
    expect(SearchResults.parse(empty).top).toBeUndefined()
  })

  it('takes only the three match scores', () => {
    for (const score of [0, 4, 1.5]) expect(() => SearchResults.parse({ ...empty, top: { type: 'track', id, score } })).toThrow()
  })
})

describe('SearchQuery facets', () => {
  it('parses URL values for the new types and facets', () => {
    expect(SearchQuery.parse({ q: 'moon', type: 'lyrics', quality: 'hi-res', decade: '1990', liked: 'true' }))
      .toMatchObject({ type: 'lyrics', quality: 'hi-res', decade: 1990, liked: true })
    expect(SearchQuery.safeParse({ q: 'moon', type: 'playlist' }).success).toBe(true)
    expect(SearchQuery.safeParse({ q: 'moon', type: 'credits' }).success).toBe(true)
    expect(SearchQuery.safeParse({ q: 'moon', decade: '1995' }).success).toBe(false)
  })
})
