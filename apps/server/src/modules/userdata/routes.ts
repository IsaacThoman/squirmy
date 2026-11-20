import {
  AddPlaylistItemsRequest, CreatePlaylistRequest, Id, LikeEntityType, MovePlaylistItemRequest, PageQuery, UpdatePlaylistRequest,
  UpdateUserSettings, WantEntityType,
  type AlbumSummary, type ArtistSummary, type HistoryPage, type Ok, type Page, type PlaylistDetail, type PlaylistPage, type PlaylistSummary,
  type TrackSummary, type UserSettings, type WantsResponse,
} from '@squirmy/contracts'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { requireUser } from '../../lib/auth.js'
import { listHistory } from './history.js'
import { likeEntity, listLikes, unlikeEntity } from './likes.js'
import {
  addPlaylistItems, createPlaylist, deletePlaylist, getPlaylist, listPlaylists, movePlaylistItem, removePlaylistItem, updatePlaylist,
} from './playlists.js'
import { getUserSettings, updateUserSettings } from './settings.js'
import { listWants, unwantEntity, wantEntity } from './wants.js'

const IdParams = z.object({ id: Id })
const LikeParams = z.object({ type: LikeEntityType, id: Id })
const LikeTypeParams = z.object({ type: LikeEntityType })
const WantParams = z.object({ type: WantEntityType, id: Id })
const ItemParams = z.object({ id: Id, itemId: Id })

export async function userdataRoutes(app: FastifyInstance) {
  app.addHook('onRequest', async (request) => {
    requireUser(request)
  })

  app.put('/me/likes/:type/:id', async (request): Promise<Ok> => {
    const { type, id } = LikeParams.parse(request.params)
    await likeEntity(requireUser(request).id, type, id)
    return { ok: true }
  })
  app.delete('/me/likes/:type/:id', async (request): Promise<Ok> => {
    const { type, id } = LikeParams.parse(request.params)
    await unlikeEntity(requireUser(request).id, type, id)
    return { ok: true }
  })
  app.get('/me/likes/:type', async (request): Promise<Page<TrackSummary | AlbumSummary | ArtistSummary>> =>
    listLikes(requireUser(request).id, LikeTypeParams.parse(request.params).type, PageQuery.parse(request.query)))

  app.get('/playlists', async (request): Promise<PlaylistPage> => listPlaylists(requireUser(request).id, PageQuery.parse(request.query)))
  app.post('/playlists', async (request, reply): Promise<PlaylistDetail> => {
    const playlist = await createPlaylist(requireUser(request).id, CreatePlaylistRequest.parse(request.body))
    reply.code(201)
    return playlist
  })
  app.get('/playlists/:id', async (request): Promise<PlaylistDetail> => getPlaylist(requireUser(request).id, IdParams.parse(request.params).id))
  app.patch('/playlists/:id', async (request): Promise<PlaylistSummary> =>
    updatePlaylist(requireUser(request).id, IdParams.parse(request.params).id, UpdatePlaylistRequest.parse(request.body)))
  app.delete('/playlists/:id', async (request): Promise<Ok> => {
    await deletePlaylist(requireUser(request).id, IdParams.parse(request.params).id)
    return { ok: true }
  })
  app.post('/playlists/:id/items', async (request): Promise<PlaylistDetail> => {
    const body = AddPlaylistItemsRequest.parse(request.body)
    return addPlaylistItems(requireUser(request).id, IdParams.parse(request.params).id, body.tracks, { skipDuplicates: body.skipDuplicates })
  })
  app.post('/playlists/:id/items/move', async (request): Promise<PlaylistDetail> => {
    const body = MovePlaylistItemRequest.parse(request.body)
    return movePlaylistItem(requireUser(request).id, IdParams.parse(request.params).id, body.itemId, body.toIndex)
  })
  app.delete('/playlists/:id/items/:itemId', async (request): Promise<PlaylistDetail> => {
    const { id, itemId } = ItemParams.parse(request.params)
    return removePlaylistItem(requireUser(request).id, id, itemId)
  })

  app.get('/me/history', async (request): Promise<HistoryPage> => listHistory(requireUser(request).id, PageQuery.parse(request.query)))

  app.get('/me/wants', async (request): Promise<WantsResponse> => listWants(requireUser(request).id))
  app.put('/me/wants/:type/:id', async (request): Promise<Ok> => {
    const { type, id } = WantParams.parse(request.params)
    await wantEntity(requireUser(request).id, type, id)
    return { ok: true }
  })
  app.delete('/me/wants/:type/:id', async (request): Promise<Ok> => {
    const { type, id } = WantParams.parse(request.params)
    await unwantEntity(requireUser(request).id, type, id)
    return { ok: true }
  })

  app.get('/me/settings', async (request): Promise<UserSettings> => getUserSettings(requireUser(request).id))
  app.patch('/me/settings', async (request): Promise<UserSettings> =>
    updateUserSettings(requireUser(request).id, UpdateUserSettings.parse(request.body)))
}
