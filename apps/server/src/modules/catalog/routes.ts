import {
  ArtistReleasesQuery, HomeQuery, Id, LibraryItemsQuery, LibraryQuery, PageQuery, TrackQuery, TrackSummariesRequest, TrackVersionsQuery,
  VersionPickRequest, VersionPickType,
  type Lyrics, type Ok, type TrackSummariesResponse, type TrackSummary, type TrackVersions,
} from '@squirmy/contracts'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { requireUser } from '../../lib/auth.js'
import { notFound } from '../../lib/errors.js'
import { cachedRead, type CacheTag } from '../../lib/read-cache.js'
import { home } from './home.js'
import { listLibraryItems } from './library-items.js'
import { listLibraryAlbums, listLibraryArtists, listLibraryGenres, listLibraryTracks } from './library.js'
import { albumDetail, artistDetail, artistReleases, trackDetail, trackLyrics } from './pages.js'
import { resolveOne } from './redirects.js'
import { alignedTrackSummaries } from './summaries.js'
import { setVersionPick, trackVersions } from './versions.js'

const IdParams = z.object({ id: Id })
const PickParams = z.object({ type: VersionPickType, id: Id })

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

  // The server's music: the same lists over the collection alone, nobody's saves, with the
  // per-viewer fields (`inLibrary`) still the viewer's.
  app.get('/collection/albums', async (request, reply) => {
    const userId = requireUser(request).id
    const query = LibraryQuery.parse(request.query)
    return cachedRead(request, reply, { userId, tags: lists }, () => listLibraryAlbums(null, query))
  })
  app.get('/collection/artists', async (request, reply) => {
    const userId = requireUser(request).id
    const query = LibraryQuery.parse(request.query)
    return cachedRead(request, reply, { userId, tags: lists }, () => listLibraryArtists(null, query, userId))
  })
  app.get('/collection/tracks', async (request, reply) => {
    const userId = requireUser(request).id
    const query = LibraryQuery.parse(request.query)
    return cachedRead(request, reply, { userId, tags: lists }, () => listLibraryTracks(null, query, userId))
  })

  app.get('/home', async (request, reply) => {
    const userId = requireUser(request).id
    const query = HomeQuery.parse(request.query)
    return cachedRead(request, reply, { userId, tags: everything, rewarm: true }, () => home(userId, query))
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
  app.get('/tracks/:id/versions', async (request): Promise<TrackVersions> => {
    const { id } = IdParams.parse(request.params)
    const query = TrackVersionsQuery.parse(request.query)
    const [recordingId, albumId] = await Promise.all([
      resolveOne('recordings', id),
      query.albumId ? resolveOne('albums', query.albumId).then((album) => album ?? query.albumId) : undefined,
    ])
    if (!recordingId) throw notFound('No such track', 'track_not_found')
    return trackVersions(requireUser(request).id, recordingId, albumId)
  })

  // The version of an album or a song that plays by default (docs/architecture.md, "Editions and versions").
  app.put('/me/versions/:type/:id', async (request): Promise<Ok> => {
    const { type, id } = PickParams.parse(request.params)
    await setVersionPick(requireUser(request).id, type, id, VersionPickRequest.parse(request.body).versionId)
    return { ok: true }
  })
  app.delete('/me/versions/:type/:id', async (request): Promise<Ok> => {
    const { type, id } = PickParams.parse(request.params)
    await setVersionPick(requireUser(request).id, type, id, null)
    return { ok: true }
  })

  app.post('/tracks/summaries', async (request): Promise<TrackSummariesResponse> => {
    const body = TrackSummariesRequest.parse(request.body)
    const summaries = await alignedTrackSummaries(requireUser(request).id, body.tracks)
    const found = summaries.flatMap((summary, index) => (summary ? [{ summary, requestedId: body.tracks[index]!.id }] : []))
    return { tracks: found.map((one) => one.summary), requestedIds: found.map((one) => one.requestedId) }
  })
}
