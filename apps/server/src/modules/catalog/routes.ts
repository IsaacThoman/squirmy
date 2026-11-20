import {
  Id, LibraryAlbumsQuery, LibraryTracksQuery, PageQuery, TrackQuery, TrackSummariesRequest,
  type AlbumDetail, type AlbumPage, type ArtistDetail, type ArtistPage, type GenrePage, type HomeResponse, type Lyrics,
  type TrackPage, type TrackSummariesResponse, type TrackSummary,
} from '@squirmy/contracts'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { requireUser } from '../../lib/auth.js'
import { home } from './home.js'
import { listLibraryAlbums, listLibraryArtists, listLibraryGenres, listLibraryTracks } from './library.js'
import { albumDetail, artistDetail, trackDetail, trackLyrics } from './pages.js'
import { trackSummaries } from './summaries.js'

const IdParams = z.object({ id: Id })

export async function catalogRoutes(app: FastifyInstance) {
  app.addHook('onRequest', async (request) => {
    requireUser(request)
  })

  app.get('/library/albums', async (request): Promise<AlbumPage> => listLibraryAlbums(LibraryAlbumsQuery.parse(request.query)))
  app.get('/library/artists', async (request): Promise<ArtistPage> => listLibraryArtists(PageQuery.parse(request.query)))
  app.get('/library/tracks', async (request): Promise<TrackPage> =>
    listLibraryTracks(requireUser(request).id, LibraryTracksQuery.parse(request.query)))
  app.get('/library/genres', async (request): Promise<GenrePage> => listLibraryGenres(PageQuery.parse(request.query)))

  app.get('/home', async (request): Promise<HomeResponse> => home(requireUser(request).id))

  app.get('/artists/:id', async (request): Promise<ArtistDetail> =>
    artistDetail(requireUser(request).id, IdParams.parse(request.params).id))
  app.get('/albums/:id', async (request): Promise<AlbumDetail> =>
    albumDetail(requireUser(request).id, IdParams.parse(request.params).id))
  app.get('/tracks/:id', async (request): Promise<TrackSummary> =>
    trackDetail(requireUser(request).id, IdParams.parse(request.params).id, TrackQuery.parse(request.query).albumId))
  app.get('/tracks/:id/lyrics', async (request): Promise<Lyrics> => trackLyrics(IdParams.parse(request.params).id))

  app.post('/tracks/summaries', async (request): Promise<TrackSummariesResponse> => {
    const body = TrackSummariesRequest.parse(request.body)
    return { tracks: await trackSummaries(requireUser(request).id, body.tracks) }
  })
}
