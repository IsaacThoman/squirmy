import { SearchQuery, type SearchResults } from '@squirmy/contracts'
import type { FastifyInstance } from 'fastify'
import { requireUser } from '../../lib/auth.js'
import { matchKey } from '../../lib/text.js'
import { albumSummaries, artistSummaries, trackSummaries } from '../catalog/summaries.js'
import { searchLibrary } from './library.js'
import { materialize, type StubIds } from './materialize.js'
import { searchCatalog } from './providers.js'

/** Queries whose `matchKey` is shorter than this many characters answer nothing. */
const minQueryLength = 2

async function respond(userId: string, ids: StubIds, provider: string | null): Promise<SearchResults> {
  const [artists, albums, tracks] = await Promise.all([
    artistSummaries(ids.artists),
    albumSummaries(ids.albums),
    trackSummaries(userId, ids.tracks.map((id) => ({ id }))),
  ])
  return { artists, albums, tracks, provider }
}

const empty: SearchResults = { artists: [], albums: [], tracks: [], provider: null }

export async function searchRoutes(app: FastifyInstance) {
  app.get('/search/library', async (request): Promise<SearchResults> => {
    const user = requireUser(request)
    const { q, limit } = SearchQuery.parse(request.query)
    const key = matchKey(q)
    if ([...key].length < minQueryLength) return empty
    return respond(user.id, await searchLibrary(user.id, key, limit), null)
  })

  app.get('/search/catalog', async (request): Promise<SearchResults> => {
    const user = requireUser(request)
    const { q, limit } = SearchQuery.parse(request.query)
    if ([...matchKey(q)].length < minQueryLength) return empty
    const { provider, results } = await searchCatalog(q, limit)
    if (!provider) return empty
    return respond(user.id, await materialize(provider.idSource, results), provider.name)
  })
}
