import { SearchQuery, type SearchResults } from '@squirmy/contracts'
import type { FastifyInstance } from 'fastify'
import { requireUser } from '../../lib/auth.js'
import { dropCachedReads } from '../../lib/read-cache.js'
import { matchKey } from '../../lib/text.js'
import { albumSummaries, artistSummaries, trackSummaries } from '../catalog/summaries.js'
import { warmDetail } from '../enrichment/detail.js'
import { searchLibrary } from './library.js'
import { materialize, type StubIds } from './materialize.js'
import { searchCatalog } from './providers.js'
import { topResult } from './top.js'

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
    if ([...matchKey(q)].length < minQueryLength) return empty
    const { provider, results } = await searchCatalog(q, limit)
    if (!provider) return empty
    const ids = await materialize(provider.idSource, results)
    // Stubs credit artists and fill in missing covers, which artist pages, album pages and
    // lists show, and nothing announces them, so cached reads go (lib/read-cache.ts).
    dropCachedReads('all', [['catalog-stubs']])
    const answer = await respond(user.id, q, ids, provider.name)
    // A catalog result's page fetches its detail when opened, which can take seconds; start
    // on the one the user is most likely to open (the top result, else the first album).
    const top = answer.top?.type === 'track' ? null : answer.top
    if (top) warmDetail(top.type as 'album' | 'artist', top.id)
    else if (answer.albums[0]) warmDetail('album', answer.albums[0].id)
    return answer
  })
}
