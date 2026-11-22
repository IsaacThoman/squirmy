import {
  AddPlaylistItemsRequest, CreatePlaylistRequest, Id, LibraryEntityType, LikeEntityType, MovePlaylistItemRequest, PageQuery, UpdatePlaylistRequest,
  UpdateUserSettings, WantEntityType,
  type AlbumSummary, type ArtistSummary, type HistoryPage, type Ok, type Page, type PlaylistDetail, type PlaylistPage, type PlaylistSummary,
  type TrackSummary, type UserSettings, type WantPage,
} from '@squirmy/contracts'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { requireUser } from '../../lib/auth.js'
import { notFound } from '../../lib/errors.js'
import { cachedRead, type CacheTag } from '../../lib/read-cache.js'
import { getServerSettings } from '../../lib/settings.js'
import { listHistory } from './history.js'
import { removeFromLibrary, saveToLibrary } from './library.js'
import { likeEntity, listLikes, unlikeEntity } from './likes.js'
import {
  addPlaylistItems, createPlaylist, deletePlaylist, getPlaylist, listPlaylists, movePlaylistItem, removePlaylistItem, updatePlaylist,
} from './playlists.js'
import { getUserSettings, updateUserSettings } from './settings.js'
import { listWants, unwantEntity, wantEntity } from './wants.js'

const IdParams = z.object({ id: Id })
const LikeParams = z.object({ type: LikeEntityType, id: Id })
const LikeTypeParams = z.object({ type: LikeEntityType })
const LibraryParams = z.object({ type: LibraryEntityType, id: Id })
const WantParams = z.object({ type: WantEntityType, id: Id })
const ItemParams = z.object({ id: Id, itemId: Id })

async function requireWantlist() {
  if (!(await getServerSettings()).wantlistEnabled) throw notFound('The wantlist is switched off on this server', 'wantlist_disabled')
}

// What the cached playlist reads depend on (lib/read-cache.ts). Covers and durations come
// from the albums and recordings; items carry track summaries.
const playlistList: CacheTag[] = ['playlists', 'album', 'track', 'library']
const playlistPage: CacheTag[] = ['playlists', 'album', 'artist', 'track', 'library', 'search', 'likes']

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

  app.put('/me/library/:type/:id', async (request): Promise<Ok> => {
    const { type, id } = LibraryParams.parse(request.params)
    await saveToLibrary(requireUser(request).id, type, id)
    return { ok: true }
  })
  app.delete('/me/library/:type/:id', async (request): Promise<Ok> => {
    const { type, id } = LibraryParams.parse(request.params)
    await removeFromLibrary(requireUser(request).id, type, id)
    return { ok: true }
  })

  app.get('/playlists', async (request, reply) => {
    const userId = requireUser(request).id
    const query = PageQuery.parse(request.query)
    return cachedRead(request, reply, { userId, tags: playlistList }, (): Promise<PlaylistPage> => listPlaylists(userId, query))
  })
  app.post('/playlists', async (request, reply): Promise<PlaylistSummary> => {
    const playlist = await createPlaylist(requireUser(request).id, CreatePlaylistRequest.parse(request.body))
    reply.code(201)
    return playlist
  })
  app.get('/playlists/:id', async (request, reply) => {
    const userId = requireUser(request).id
    const { id } = IdParams.parse(request.params)
    return cachedRead(request, reply, { userId, tags: playlistPage }, (): Promise<PlaylistDetail> => getPlaylist(userId, id))
  })
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

  // With the wantlist switched off it reads as empty and refuses changes, leaving the stored
  // wants as they were so switching it back on brings them back.
  app.get('/me/wants', async (request): Promise<WantPage> => {
    const query = PageQuery.parse(request.query)
    if (!(await getServerSettings()).wantlistEnabled) return { items: [], nextCursor: null }
    return listWants(requireUser(request).id, query)
  })
  app.put('/me/wants/:type/:id', async (request): Promise<Ok> => {
    const { type, id } = WantParams.parse(request.params)
    await requireWantlist()
    await wantEntity(requireUser(request).id, type, id)
    return { ok: true }
  })
  app.delete('/me/wants/:type/:id', async (request): Promise<Ok> => {
    const { type, id } = WantParams.parse(request.params)
    await requireWantlist()
    await unwantEntity(requireUser(request).id, type, id)
    return { ok: true }
  })

  app.get('/me/settings', async (request): Promise<UserSettings> => getUserSettings(requireUser(request).id))
  app.patch('/me/settings', async (request): Promise<UserSettings> =>
    updateUserSettings(requireUser(request).id, UpdateUserSettings.parse(request.body)))
}
