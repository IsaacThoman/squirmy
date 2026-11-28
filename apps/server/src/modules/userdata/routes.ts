import { Readable } from 'node:stream'
import {
  AddPlaylistItemsRequest, CreatePlaylistRequest, HistoryExportQuery, HistoryImportQuery, Id, LibraryEntityType, LibraryPinKind, LikeEntityType, LikeQuery, MovePlaylistItemRequest, PageQuery, UpdatePlaylistRequest,
  PlaylistCollaboratorRole, PlaylistDedupeRequest, PlaylistExportFormat, PlaylistFolderRequest,
  RatingRequest, ReplayQuery, SmartPlaylistRules, UpdateUserSettings, WantEntityType,
  type AlbumSummary, type ArtistSummary, type HistoryPage, type Ok, type Page, type PlaylistDetail, type PlaylistPage, type PlaylistSummary,
  type PlaylistCollaborator, type PlaylistDedupeResult, type PlaylistFolder, type PlaylistImportResult, type PlaylistPerson,
  type SmartPlaylistPreview, type TrackSummary, type UnlikeResponse, type UserSettings, type WantPage,
} from '@squirmy/contracts'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { requireUser } from '../../lib/auth.js'
import { notFound } from '../../lib/errors.js'
import { cachedRead, type CacheTag } from '../../lib/read-cache.js'
import { getServerSettings } from '../../lib/settings.js'
import { exportHistory } from './history-export.js'
import { listHistoryImports, uploadHistory } from './history-import.js'
import { getReplay } from './replay.js'
import { listHistory } from './history.js'
import { pinLibraryItem, unpinLibraryItem } from './library-pins.js'
import { likeEntity, listLikes, setRating, unlikeEntity } from './likes.js'
import { exportPlaylist, importPlaylist, readPlaylistFile } from './playlist-files.js'
import {
  createPlaylistFolder, dedupePlaylist, deletePlaylistFolder, listPlaylistCollaborators,
  listPlaylistFolders, playlistPeople, setPlaylistCollaborator, setPlaylistCover,
  addPlaylistItems, createPlaylist, deletePlaylist, getPlaylist, listPlaylists, movePlaylistItem, previewSmartPlaylist, removePlaylistItem, updatePlaylist,
} from './playlists.js'
import { getUserSettings, updateUserSettings } from './settings.js'
import { listWants, unwantEntity, wantEntity } from './wants.js'

const IdParams = z.object({ id: Id })
const LikeParams = z.object({ type: LikeEntityType, id: Id })
const LikeTypeParams = z.object({ type: LikeEntityType })
const LibraryParams = z.object({ type: LibraryEntityType, id: Id })
const WantParams = z.object({ type: WantEntityType, id: Id })
const PinParams = z.object({ kind: LibraryPinKind, id: Id })
const CollaboratorParams = z.object({ id: Id, userId: Id })
const ItemParams = z.object({ id: Id, itemId: Id })

async function requireWantlist() {
  if (!(await getServerSettings()).wantlistEnabled) throw notFound('The wantlist is switched off on this server', 'wantlist_disabled')
}

// What the cached playlist reads depend on (lib/read-cache.ts). Covers and durations come
// from the albums and recordings; items carry track summaries. Smart playlists' songs come
// from the library and the hearts as well.
const playlistList: CacheTag[] = ['playlists', 'album', 'track', 'library', 'likes']
const playlistPage: CacheTag[] = ['playlists', 'album', 'artist', 'track', 'library', 'search', 'likes']

export async function userdataRoutes(app: FastifyInstance) {
  app.addHook('onRequest', async (request) => {
    requireUser(request)
  })

  app.put('/me/likes/:type/:id', async (request): Promise<Ok> => {
    const { type, id } = LikeParams.parse(request.params)
    await likeEntity(requireUser(request).id, type, id, LikeQuery.parse(request.query))
    return { ok: true }
  })
  app.delete('/me/likes/:type/:id', async (request): Promise<UnlikeResponse> => {
    const { type, id } = LikeParams.parse(request.params)
    const savedAt = await unlikeEntity(requireUser(request).id, type, id)
    return { ok: true, savedAt: savedAt?.toISOString() ?? null }
  })
  app.get('/me/likes/:type', async (request): Promise<Page<TrackSummary | AlbumSummary | ArtistSummary>> =>
    listLikes(requireUser(request).id, LikeTypeParams.parse(request.params).type, PageQuery.parse(request.query)))

  app.put('/me/ratings/:type/:id', async (request): Promise<Ok> => {
    const { type, id } = LikeParams.parse(request.params)
    await setRating(requireUser(request).id, type, id, RatingRequest.parse(request.body).rating)
    return { ok: true }
  })

  // Deprecated aliases of the heart, for app builds from before it was the one library
  // control: "Add to library" there now writes the same save. Remove after a release.
  app.put('/me/library/:type/:id', async (request): Promise<Ok> => {
    const { type, id } = LibraryParams.parse(request.params)
    await likeEntity(requireUser(request).id, type, id)
    return { ok: true }
  })
  app.delete('/me/library/:type/:id', async (request): Promise<Ok> => {
    const { type, id } = LibraryParams.parse(request.params)
    await unlikeEntity(requireUser(request).id, type, id)
    return { ok: true }
  })

  app.put('/me/pins/:kind/:id', async (request): Promise<Ok> => {
    const { kind, id } = PinParams.parse(request.params)
    await pinLibraryItem(requireUser(request).id, kind, id)
    return { ok: true }
  })
  app.delete('/me/pins/:kind/:id', async (request): Promise<Ok> => {
    const { kind, id } = PinParams.parse(request.params)
    await unpinLibraryItem(requireUser(request).id, kind, id)
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
  app.post('/playlists/smart/preview', async (request): Promise<SmartPlaylistPreview> =>
    previewSmartPlaylist(requireUser(request).id, SmartPlaylistRules.parse(request.body)))
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
    return movePlaylistItem(requireUser(request).id, IdParams.parse(request.params).id, body.itemId, body.toIndex, body.anchor)
  })
  app.delete('/playlists/:id/items/:itemId', async (request): Promise<PlaylistDetail> => {
    const { id, itemId } = ItemParams.parse(request.params)
    return removePlaylistItem(requireUser(request).id, id, itemId)
  })

  app.get('/playlists/folders', async (request): Promise<PlaylistFolder[]> => listPlaylistFolders(requireUser(request).id))
  app.post('/playlists/folders', async (request, reply): Promise<PlaylistFolder> => {
    const folder = await createPlaylistFolder(requireUser(request).id, PlaylistFolderRequest.parse(request.body).name)
    reply.code(201)
    return folder
  })
  app.delete('/playlists/folders/:id', async (request): Promise<Ok> => {
    await deletePlaylistFolder(requireUser(request).id, IdParams.parse(request.params).id)
    return { ok: true }
  })

  app.get('/playlists/:id/collaborators', async (request): Promise<PlaylistCollaborator[]> =>
    listPlaylistCollaborators(requireUser(request).id, IdParams.parse(request.params).id))
  app.get('/playlists/:id/people', async (request): Promise<PlaylistPerson[]> => {
    const { q } = z.object({ q: z.string().trim().max(120).default('') }).parse(request.query)
    return playlistPeople(requireUser(request).id, IdParams.parse(request.params).id, q)
  })
  app.put('/playlists/:id/collaborators/:userId', async (request): Promise<Ok> => {
    const { id, userId } = CollaboratorParams.parse(request.params)
    const { role } = z.object({ role: PlaylistCollaboratorRole }).parse(request.body)
    await setPlaylistCollaborator(requireUser(request).id, id, userId, role)
    return { ok: true }
  })
  app.delete('/playlists/:id/collaborators/:userId', async (request): Promise<Ok> => {
    const { id, userId } = CollaboratorParams.parse(request.params)
    await setPlaylistCollaborator(requireUser(request).id, id, userId, null)
    return { ok: true }
  })

  app.post('/playlists/:id/cover', async (request): Promise<PlaylistSummary> => {
    const { id } = IdParams.parse(request.params)
    const { bytes } = await readPlaylistFile(request, 32 * 1024 * 1024)
    return setPlaylistCover(requireUser(request).id, id, bytes)
  })
  app.delete('/playlists/:id/cover', async (request): Promise<PlaylistSummary> =>
    setPlaylistCover(requireUser(request).id, IdParams.parse(request.params).id, null))

  app.post('/playlists/import', async (request, reply): Promise<PlaylistImportResult> => {
    const { name, bytes } = await readPlaylistFile(request, 4 * 1024 * 1024)
    const result = await importPlaylist(requireUser(request).id, name, bytes)
    reply.code(201)
    return result
  })
  app.get('/playlists/:id/export', async (request, reply) => {
    const { id } = IdParams.parse(request.params)
    const { format } = z.object({ format: PlaylistExportFormat }).parse(request.query)
    const body = await exportPlaylist(requireUser(request).id, id, format)
    const mime = { json: 'application/json', m3u8: 'application/vnd.apple.mpegurl', xspf: 'application/xspf+xml' }
    return reply.type(`${mime[format]}; charset=utf-8`)
      .header('Cache-Control', 'private, no-store')
      .header('Content-Disposition', `attachment; filename="playlist-${id}.${format}"`)
      .send(body)
  })
  app.post('/playlists/:id/items/dedupe', async (request): Promise<PlaylistDedupeResult> => {
    const { editions } = PlaylistDedupeRequest.parse(request.body)
    return dedupePlaylist(requireUser(request).id, IdParams.parse(request.params).id, editions ?? false)
  })

  app.get('/me/history', async (request): Promise<HistoryPage> => listHistory(requireUser(request).id, PageQuery.parse(request.query)))

  app.get('/me/replay', async (request, reply) => {
    reply.header('Cache-Control', 'private, no-store')
    return getReplay(requireUser(request).id, ReplayQuery.parse(request.query))
  })
  app.get('/me/history/export', async (request, reply) => {
    const { format } = HistoryExportQuery.parse(request.query)
    return reply
      .type(format === 'json' ? 'application/json' : 'text/csv; charset=utf-8')
      .header('Cache-Control', 'private, no-store')
      .header('Content-Disposition', `attachment; filename="squirmy-history.${format}"`)
      .send(Readable.from(exportHistory(requireUser(request).id, format)))
  })
  app.get('/me/history/imports', async (request, reply) => {
    reply.header('Cache-Control', 'private, no-store')
    return listHistoryImports(requireUser(request).id)
  })
  app.post('/me/history/imports', async (request, reply) => {
    const { source } = HistoryImportQuery.parse(request.query)
    const job = await uploadHistory(requireUser(request).id, source, request)
    return reply.code(202).send(job)
  })

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
