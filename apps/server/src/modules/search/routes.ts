import { SearchQuery, type SearchResults } from '@squirmy/contracts'
import type { FastifyInstance } from 'fastify'
import { requireUser } from '../../lib/auth.js'
import { matchKey } from '../../lib/text.js'
import { albumSummaries, artistSummaries, trackSummaries } from '../catalog/summaries.js'
import { searchLibrary } from './library.js'
import { materialize, type StubIds } from './materialize.js'
import { searchCatalog } from './providers.js'
import { topResult } from './top.js'
import { warmAlbums, warmedPerSearch } from './warm.js'

/** Queries whose `matchKey` is shorter than this many characters answer nothing. */
const minQueryLength = 2

async function respond(userId: string, query: string, ids: StubIds, provider: string | null): Promise<SearchResults> {
  const [artists, albums, tracks] = await Promise.all([
    artistSummaries(ids.artists),
    albumSummaries(ids.albums),
    trackSummaries(userId, ids.tracks.map((id) => ({ id }))),
  ])
  return { artists, albums, tracks, provider, top: await topResult(query, { artists, albums, tracks }) }
}

const empty: SearchResults = { artists: [], albums: [], tracks: [], provider: null, top: null }

export async function searchRoutes(app: FastifyInstance) {
  app.get('/search/library', async (request): Promise<SearchResults> => {
    const user = requireUser(request)
    const { q, limit } = SearchQuery.parse(request.query)
    const key = matchKey(q)
    if ([...key].length < minQueryLength) return empty
    return respond(user.id, q, await searchLibrary(user.id, key, limit), null)
  })

  app.get('/search/catalog', async (request): Promise<SearchResults> => {
    const user = requireUser(request)
    const { q, limit } = SearchQuery.parse(request.query)
    const key = matchKey(q)
    if ([...key].length < minQueryLength) return empty
    // The library answer for the same query runs alongside the provider call, so the
    // catalog answer can leave out what the library answer already shows. Results are
    // matched to owned rows on purpose (materialize.ts), so without this the user's own
    // albums would come back a second time as "not in your library".
    const [{ provider, results }, library] = await Promise.all([searchCatalog(q, limit), searchLibrary(user.id, key, limit)])
    if (!provider) return empty
    const ids = await materialize(provider.idSource, results)
    const without = (found: string[], shown: string[]) => found.filter((id) => !shown.includes(id))
    const answer = await respond(user.id, q, {
      artists: without(ids.artists, library.artists),
      albums: without(ids.albums, library.albums),
      tracks: without(ids.tracks, library.tracks),
    }, provider.name)
    // A stub album is gray and its page waits for providers until its track list is
    // fetched; start on the first ones now so they are playable when the user gets there.
    warmAlbums(answer.albums.filter((album) => album.trackCount === 0).slice(0, warmedPerSearch).map((album) => album.id))
    return answer
  })
}
