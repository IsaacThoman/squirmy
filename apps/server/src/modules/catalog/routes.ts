import {
  ArtistReleasesQuery, Id, LibraryItemsQuery, LibraryQuery, PageQuery, TrackQuery, TrackSummariesRequest,
  type Lyrics, type TrackSummariesResponse, type TrackSummary,
} from '@squirmy/contracts'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { requireUser } from '../../lib/auth.js'
import { cachedRead, type CacheTag } from '../../lib/read-cache.js'
import { home } from './home.js'
import { listLibraryItems } from './library-items.js'
import { listLibraryAlbums, listLibraryArtists, listLibraryGenres, listLibraryTracks } from './library.js'
import { albumDetail, artistDetail, artistReleases, trackDetail, trackLyrics } from './pages.js'
import { alignedTrackSummaries } from './summaries.js'

const IdParams = z.object({ id: Id })

// What each cached read depends on (lib/read-cache.ts): an invalidation of any of these
// key roots drops it. Track and album summaries carry availability, artwork and likes.
const everything: CacheTag[] = ['home', 'library', 'album', 'artist', 'track', 'search', 'likes', 'playlists', 'history', 'wants']
const lists: CacheTag[] = ['library', 'album', 'artist', 'track', 'search', 'likes']
// All also lists the playlists.
const items: CacheTag[] = [...lists, 'playlists']
const albumPage: CacheTag[] = ['album', 'artist', 'track', 'library', 'search', 'likes', 'wants']
// Top tracks are ranked by plays.
const artistPage: CacheTag[] = ['artist', 'album', 'track', 'library', 'search', 'likes', 'history']

export async function catalogRoutes(app: FastifyInstance) {
  app.addHook('onRequest', async (request) => {
    requireUser(request)
  })

  app.get('/library/items', async (request, reply) => {
    const userId = requireUser(request).id
    const query = LibraryItemsQuery.parse(request.query)
    return cachedRead(request, reply, { userId, tags: items }, () => listLibraryItems(userId, query))
  })
  app.get('/library/albums', async (request, reply) => {
    const userId = requireUser(request).id
    const query = LibraryQuery.parse(request.query)
    return cachedRead(request, reply, { userId, tags: lists }, () => listLibraryAlbums(userId, query))
  })
  app.get('/library/artists', async (request, reply) => {
    const userId = requireUser(request).id
    const query = LibraryQuery.parse(request.query)
    return cachedRead(request, reply, { userId, tags: lists }, () => listLibraryArtists(userId, query))
  })
  app.get('/library/tracks', async (request, reply) => {
    const userId = requireUser(request).id
    const query = LibraryQuery.parse(request.query)
    return cachedRead(request, reply, { userId, tags: lists }, () => listLibraryTracks(userId, query))
  })
  app.get('/library/genres', async (request, reply) => {
    const userId = requireUser(request).id
    const query = PageQuery.parse(request.query)
    return cachedRead(request, reply, { userId, tags: lists }, () => listLibraryGenres(userId, query))
  })

  app.get('/home', async (request, reply) => {
    const userId = requireUser(request).id
    return cachedRead(request, reply, { userId, tags: everything, rewarm: true }, () => home(userId))
  })

  app.get('/artists/:id', async (request, reply) => {
    const userId = requireUser(request).id
    const { id } = IdParams.parse(request.params)
    return cachedRead(request, reply, { userId, tags: artistPage }, () => artistDetail(userId, id))
  })
  app.get('/artists/:id/releases', async (request, reply) => {
    const userId = requireUser(request).id
    const { id } = IdParams.parse(request.params)
    const query = ArtistReleasesQuery.parse(request.query)
    return cachedRead(request, reply, { userId, tags: lists }, () => artistReleases(id, query))
  })
  app.get('/albums/:id', async (request, reply) => {
    const userId = requireUser(request).id
    const { id } = IdParams.parse(request.params)
    return cachedRead(request, reply, { userId, tags: albumPage }, () => albumDetail(userId, id))
  })
  app.get('/tracks/:id', async (request): Promise<TrackSummary> =>
    trackDetail(requireUser(request).id, IdParams.parse(request.params).id, TrackQuery.parse(request.query).albumId))
  app.get('/tracks/:id/lyrics', async (request): Promise<Lyrics> => trackLyrics(IdParams.parse(request.params).id))

  app.post('/tracks/summaries', async (request): Promise<TrackSummariesResponse> => {
    const body = TrackSummariesRequest.parse(request.body)
    const summaries = await alignedTrackSummaries(requireUser(request).id, body.tracks)
    const found = summaries.flatMap((summary, index) => (summary ? [{ summary, requestedId: body.tracks[index]!.id }] : []))
    return { tracks: found.map((one) => one.summary), requestedIds: found.map((one) => one.requestedId) }
  })
}
