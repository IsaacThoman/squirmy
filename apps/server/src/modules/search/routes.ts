import { LibrarySearchQuery, SearchQuery, type AlbumSummary, type SearchKind, type SearchResults } from '@squirmy/contracts'
import type { FastifyInstance } from 'fastify'
import { requireUser } from '../../lib/auth.js'
import { matchKey } from '../../lib/text.js'
import { albumSummaries, artistSummaries, trackSummaries } from '../catalog/summaries.js'
import { warmDetail } from '../enrichment/detail.js'
import { searchLibrary } from './library.js'
import { labelFreeKey } from './keys.js'
import { materialize, type StubIds } from './materialize.js'
import { withoutNamesakes } from './namesakes.js'
import { allKinds, searchCatalog } from './providers.js'
import { topOf, type Ranked } from './rank.js'
import { rankFound, withLiked, type Found } from './top.js'
import { warmAlbums } from './warm.js'

/**
 * Queries whose `matchKey` is shorter than this many characters answer nothing. A query of
 * symbols alone (the band "!!!"), whose `matchKey` is empty, still goes to the provider.
 */
const minQueryLength = 2
const tooShort = (q: string, key: string) => (key === '' ? q.trim() === '' : [...key].length < minQueryLength)

async function summaries(userId: string, ids: StubIds): Promise<Found> {
  const [artists, albums, tracks] = await Promise.all([
    artistSummaries(ids.artists, userId),
    albumSummaries(ids.albums),
    trackSummaries(userId, ids.tracks.map((id) => ({ id }))),
  ])
  return withLiked(userId, { artists, albums, tracks })
}

/**
 * The same artist, album or song can reach an answer twice under one id (a provider that
 * lists an album twice, the library and a merge pointing at one row). Lists keep their first.
 */
function distinct(found: Found): Found {
  const once = <T extends { id: string }>(items: T[]) => items.filter((item, index) => items.findIndex((other) => other.id === item.id) === index)
  return { artists: once(found.artists), albums: once(found.albums), tracks: once(found.tracks) }
}

/**
 * One card per album name and artist. Deezer lists one edition several times (the explicit
 * and the clean "SOS Deluxe: LANA", another pressing), each a row of its own, and search
 * showed the same card three times. The first, which ranks highest, stands for the others;
 * so does a copy the library answer already shows. Different editions keep their names
 * ("SOS" and "SOS Deluxe: LANA") and so stay apart.
 */
export function oncePerTitle(albums: AlbumSummary[], shown: readonly AlbumSummary[] = []): AlbumSummary[] {
  const key = (album: AlbumSummary) => `${matchKey(album.artistCredit)}|${labelFreeKey(album.title)}`
  const seen = new Set(shown.map(key))
  return albums.filter((album) => {
    if (seen.has(key(album))) return false
    seen.add(key(album))
    return true
  })
}

const empty: SearchResults = { artists: [], albums: [], tracks: [], provider: null, top: null, ranked: [] }
const ranked = (list: Ranked[]) => list.map(({ type, id, score }) => ({ type, id, score }))

export async function searchRoutes(app: FastifyInstance) {
  app.get('/search/library', async (request): Promise<SearchResults> => {
    const user = requireUser(request)
    const { q, limit, type, offset, genre, scope } = LibrarySearchQuery.parse(request.query)
    const key = matchKey(q)
    // Library keys are `matchKey`s too, so a query of symbols alone can find nothing there.
    if (tooShort(q, key) || key === '') return empty
    // With a genre, a search inside the Library's genre chip stays in it.
    const ids = await searchLibrary(user.id, key, limit, { offset, types: type && [type], genre, scope })
    const unique = distinct(await summaries(user.id, ids))
    const found = { ...unique, albums: oncePerTitle(unique.albums) }
    // Results matched from the local catalog get the library search's prominence boost.
    const list = await rankFound(q, found, { userId: user.id, owned: [...ids.artists, ...ids.albums, ...ids.tracks] })
    return { ...found, provider: null, top: topOf(list), ranked: ranked(list) }
  })

  app.get('/search/catalog', async (request): Promise<SearchResults> => {
    const user = requireUser(request)
    const { q, limit, type, offset, scope } = SearchQuery.parse(request.query)
    const key = matchKey(q)
    if (tooShort(q, key)) return empty
    const types: readonly SearchKind[] = type ? [type] : allKinds
    // The library answer for the same query runs alongside the provider call, so the
    // catalog answer can leave out what the library answer already shows: on this page or
    // an earlier one. Results are matched to owned rows on purpose (materialize.ts), so
    // without this the user's own albums would come back a second time as "not in your library".
    const [{ provider, results }, library] = await Promise.all([
      searchCatalog(q, limit, undefined, { offset, types }),
      key ? searchLibrary(user.id, key, limit + offset, { types, scope }) : { artists: [], albums: [], tracks: [] },
    ])
    if (!provider) return empty
    const stored = await materialize(provider.idSource, results)
    const without = (found: string[], shown: string[]) => found.filter((id) => !shown.includes(id))
    const own = distinct(await summaries(user.id, {
      // One artist per name: Deezer's duplicate pages of one artist are two rows until enrichment merges them.
      artists: await withoutNamesakes(without(stored.artists, library.artists), library.artists),
      albums: without(stored.albums, library.albums),
      tracks: without(stored.tracks, library.tracks),
    }))
    // The library answer's page is ranked here too, with what the provider knows about it
    // (fans, plays), so the client can place its rows among these on one scale.
    const page = { artists: library.artists.slice(offset), albums: library.albums.slice(offset), tracks: library.tracks.slice(offset) }
    const libraryPage = await summaries(user.id, page)
    own.albums = oncePerTitle(own.albums, libraryPage.albums)
    const list = await rankFound(q, {
      artists: [...own.artists, ...libraryPage.artists],
      albums: [...own.albums, ...libraryPage.albums],
      tracks: [...own.tracks, ...libraryPage.tracks],
    }, { userId: user.id, popularity: stored.popularity, owned: [...page.artists, ...page.albums, ...page.tracks] })
    const ownIds = new Set([...own.artists, ...own.albums, ...own.tracks].map((item) => item.id))
    // `top` names an item of this answer's own lists, as older clients expect.
    const answer: SearchResults = { ...own, provider: provider.name, top: topOf(list.filter((item) => ownIds.has(item.id))), ranked: ranked(list) }
    // A catalog result's page fetches its detail when opened, which can take seconds, and a
    // stub album is gray until its track list arrives. Start on what the user is likely to
    // open: the top result, then the first albums without a track list (warm.ts).
    if (offset === 0) {
      if (answer.top?.type === 'artist') warmDetail('artist', answer.top.id)
      warmAlbums([
        ...(answer.top?.type === 'album' ? [answer.top.id] : []),
        ...answer.albums.filter((album) => album.trackCount === 0).map((album) => album.id),
      ])
    }
    return answer
  })
}
