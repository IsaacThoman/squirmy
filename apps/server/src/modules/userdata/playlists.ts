/**
 * Playlists. Items point at recordings (plus the album they were added from), so they
 * survive re-rips and keep tracks that are not owned; those render gray.
 *
 * `playlist_items.position` is dense and 0-based. Every change to the items locks the
 * playlist row first, so concurrent adds, moves and removals serialize.
 *
 * A smart playlist has rules instead of items (`smart.ts`): its songs, counts and covers are
 * found for its owner on every read, and its items cannot be changed.
 */
import {
  PLAYLIST_ITEM_LIMIT, PLAYLIST_LIMIT, queryKeys,
  type Artwork, type CreatePlaylistRequest, type PageQuery, type PlaylistDetail, type PlaylistPage, type PlaylistSummary, type SmartPlaylistPreview,
  type MovePlaylistItemRequest, type PlaylistCollaborator, type PlaylistCollaboratorRole, type PlaylistDedupeResult,
  type PlaylistFolder, type PlaylistPerson, type SmartPlaylistRules, type UpdatePlaylistRequest,
} from '@squirmy/contracts'
import { and, eq, sql } from 'drizzle-orm'
import { db, type Transaction } from '../../database/client.js'
import { playlistCollaborators, playlistFolders, playlistItems, playlists, users } from '../../database/schema.js'
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors.js'
import { matchKey } from '../../lib/text.js'
import { newId } from '../../lib/ids.js'
import { invalidate, publishChanges } from '../../realtime/index.js'
import { after, cursorKeys, orderBy, toPage, type Ordering } from '../catalog/pagination.js'
import { isoTime, uuidArray } from '../catalog/sql.js'
import { alignedTrackSummaries, servable } from '../catalog/summaries.js'
import { recordCollectionAdd } from '../sessions/collection-plays.js'
import { storeImage } from '../artwork/index.js'
import { editionFreeKey } from '../search/keys.js'
import { playlistVisibleTo } from './playlist-access.js'
import { dailySeed, smartTracks, type SmartTrackRow } from './smart.js'

const playlistNotFound = () => notFound('No such playlist', 'playlist_not_found')
/** Thrown by every path that would grow a playlist past `PLAYLIST_ITEM_LIMIT`. */
export const playlistFull = () => conflict(`A playlist holds at most ${PLAYLIST_ITEM_LIMIT.toLocaleString('en')} tracks`, 'playlist_full')
/** Thrown by every path that would change the items of a smart playlist. */
export const smartPlaylistItems = () => conflict('A smart playlist’s songs come from its rules', 'smart_playlist')

type SummaryRow = Omit<PlaylistSummary, 'durationMs' | 'smart'> & { durationMs: number | string; rules: SmartPlaylistRules | null; cover: Artwork | null }

/**
 * Summaries of playlists in input order, leaving out ids that do not exist, and those the
 * viewer cannot read when `visibleTo` is given. A smart playlist's numbers and covers come
 * from its songs, evaluated here unless `evaluated` already holds them.
 */
export async function playlistSummaries(ids: readonly string[], visibleTo?: string, evaluated: ReadonlyMap<string, SmartTrackRow[]> = new Map()): Promise<PlaylistSummary[]> {
  if (ids.length === 0) return []
  const role = visibleTo ? sql`(select case when c.can_edit then 'edit' else 'add' end
    from playlist_collaborators c where c.playlist_id = p.id and c.user_id = ${visibleTo})` : sql`null`
  const rows = await db.execute<SummaryRow>(sql`
    select p.id, p.name, p.description, p.owner_id as "ownerId", coalesce(u.display_name, u.username) as "ownerName",
      p.is_public as "isPublic", ${isoTime('p.updated_at')} as "updatedAt", p.rules,
      stats."trackCount", stats."durationMs", covers.artworks,
      ${visibleTo ? sql`case when p.owner_id = ${visibleTo} then p.folder_id end` : sql`null`} as "folderId",
      ${role} as "collaboratorRole",
      (p.artwork_asset_id is not null) as "customCover",
      case when custom.id is not null then json_build_object('id', custom.id, 'color', custom.color, 'thumbhash', custom.thumbhash) end as cover
    from playlists p
    join users u on u.id = p.owner_id
    left join assets custom on custom.id = p.artwork_asset_id and ${servable('custom')}
    cross join lateral (
      select count(*)::int as "trackCount", coalesce(sum(r.duration_ms), 0)::int8 as "durationMs"
      from playlist_items i join recordings r on r.id = i.recording_id where i.playlist_id = p.id
    ) stats
    cross join lateral (
      select coalesce(json_agg(json_build_object('id', c.id, 'color', c.color, 'thumbhash', c.thumbhash) order by c.first), '[]'::json) as artworks
      from (
        -- Albums in order of first appearance, then their covers one by one until four are
        -- found: the lateral join keeps Postgres from joining every item to its album.
        select art.id, art.color, art.thumbhash, firsts.first
        from (
          select i.album_id, min(i.position) as first from playlist_items i
          where i.playlist_id = p.id and i.album_id is not null
          group by i.album_id order by first
        ) firsts
        cross join lateral (
          select art.id, art.color, art.thumbhash from albums al join assets art on art.id = al.artwork_asset_id and ${servable('art')}
          where al.id = firsts.album_id
        ) art
        order by firsts.first limit 4
      ) c
    ) covers
    where p.id = any(${uuidArray([...new Set(ids)])})
      ${visibleTo ? sql`and ${playlistVisibleTo(visibleTo)}` : sql``}`)
  const summaries = await Promise.all(rows.map(async ({ rules, cover, ...row }): Promise<PlaylistSummary> => {
    if (!rules) return { ...row, durationMs: Number(row.durationMs), artworks: cover ? [cover] : row.artworks, smart: false }
    const tracks = evaluated.get(row.id) ?? await smartTracks(row.ownerId, rules, dailySeed(row.id))
    const stats = await smartStats(tracks)
    return { ...row, ...stats, artworks: cover ? [cover] : stats.artworks, smart: true }
  }))
  const byId = new Map(summaries.map((summary) => [summary.id, summary]))
  return ids.flatMap((id) => byId.get(id) ?? [])
}

/** How many songs, how long, and up to four covers of the first albums with one, in song order. */
async function smartStats(tracks: readonly SmartTrackRow[]): Promise<Pick<PlaylistSummary, 'trackCount' | 'durationMs' | 'artworks'>> {
  const albums = [...new Set(tracks.flatMap((track) => track.albumId ? [track.albumId] : []))].slice(0, 40)
  const covers = albums.length === 0 ? [] : await db.execute<Artwork & { albumId: string }>(sql`
    select al.id as "albumId", art.id, art.color, art.thumbhash
    from albums al join assets art on art.id = al.artwork_asset_id and ${servable('art')}
    where al.id = any(${uuidArray(albums)})`)
  const coverOf = new Map(covers.map(({ albumId, ...cover }) => [albumId, cover]))
  return {
    trackCount: tracks.length,
    durationMs: tracks.reduce((sum, track) => sum + track.durationMs, 0),
    artworks: albums.flatMap((album) => coverOf.get(album) ?? []).slice(0, 4),
  }
}

/** The songs of smart rules for the user, without a playlist: what the rule editor shows as it changes. */
export async function previewSmartPlaylist(userId: string, rules: SmartPlaylistRules): Promise<SmartPlaylistPreview> {
  const tracks = await smartTracks(userId, rules, 'preview')
  return { trackCount: tracks.length, durationMs: tracks.reduce((sum, track) => sum + track.durationMs, 0) }
}

/**
 * The songs a playlist holds now, in order, as refs and whoever reads it: its items, or what a
 * smart playlist's rules find for its owner today. Does not check who may read it.
 */
export async function playlistTrackRefs(id: string): Promise<{ recordingId: string; albumId: string | null }[]> {
  const [row] = await db.select({ ownerId: playlists.ownerId, rules: playlists.rules }).from(playlists).where(eq(playlists.id, id))
  if (!row) return []
  if (row.rules) return (await smartTracks(row.ownerId, row.rules, dailySeed(id))).map((song) => ({ recordingId: song.id, albumId: song.albumId }))
  const items = await db.execute<{ recordingId: string; albumId: string | null }>(sql`
    select recording_id as "recordingId", album_id as "albumId" from playlist_items where playlist_id = ${id} order by position`)
  return [...items]
}

const playlistOrdering: Ordering = {
  name: 'playlists:updated',
  keys: [
    { expression: sql.raw('p.updated_at'), type: 'timestamptz', descending: true },
    { expression: sql.raw('p.id'), type: 'uuid', descending: true },
  ],
}

/** One page of visible playlists, or only the viewer's own. */
export async function listPlaylists(userId: string, query: PageQuery, options: { ownOnly?: boolean } = {}): Promise<PlaylistPage> {
  const visible = options.ownOnly ? sql`p.owner_id = ${userId}` : playlistVisibleTo(userId)
  const rows = await db.execute<{ id: string; cursorKeys: string[] }>(sql`
    select p.id, ${cursorKeys(playlistOrdering)} from playlists p
    where ${visible} and ${after(playlistOrdering, query.cursor)}
    order by ${orderBy(playlistOrdering)} limit ${query.limit + 1}`)
  return toPage(playlistOrdering, rows, query.limit, await playlistSummaries(rows.slice(0, query.limit).map((row) => row.id), userId))
}

/**
 * A playlist with its items. Visible to its owner, collaborators and, when public, all users.
 * A smart playlist's items are its songs as its owner's rules find them now, summarized for
 * the reader.
 */
export async function getPlaylist(userId: string, id: string): Promise<PlaylistDetail> {
  const [row] = await db.execute<{ ownerId: string; rules: SmartPlaylistRules | null; collaborative: boolean }>(sql`
    select p.owner_id as "ownerId", p.rules,
      exists (select 1 from playlist_collaborators c where c.playlist_id = p.id) as collaborative
    from playlists p where p.id = ${id} and ${playlistVisibleTo(userId)}`)
  if (!row) throw playlistNotFound()
  if (row.rules) {
    const songs = await smartTracks(row.ownerId, row.rules, dailySeed(id))
    const [[summary], tracks] = await Promise.all([
      playlistSummaries([id], userId, new Map([[id, songs]])),
      alignedTrackSummaries(userId, songs.map((song) => ({ id: song.id, albumId: song.albumId }))),
    ])
    if (!summary) throw playlistNotFound()
    return {
      ...summary,
      rules: row.rules,
      items: songs.flatMap((song, index) => {
        const track = tracks[index]
        return track ? [{ itemId: song.id, addedAt: song.addedAt, track }] : []
      }),
    }
  }
  const [summary] = await playlistSummaries([id], userId)
  if (!summary) throw playlistNotFound()
  const items = await db.execute<{ id: string; recordingId: string; albumId: string | null; addedAt: string; addedByName: string | null }>(sql`
    select i.id, i.recording_id as "recordingId", i.album_id as "albumId", ${isoTime('i.added_at')} as "addedAt",
      coalesce(u.display_name, u.username) as "addedByName"
    from playlist_items i left join users u on u.id = i.added_by
    where i.playlist_id = ${id} order by i.position, i.id`)
  const tracks = await alignedTrackSummaries(userId, items.map((item) => ({ id: item.recordingId, albumId: item.albumId })))
  return {
    ...summary,
    rules: null,
    collaborative: row.collaborative,
    items: items.flatMap((item, index) => {
      const track = tracks[index]
      return track ? [{ itemId: item.id, addedAt: item.addedAt, addedByName: item.addedByName, track }] : []
    }),
  }
}

/**
 * Locks a playlist for a change by `userId`. A playlist the user cannot see is 404; a
 * visible one they do not own is 403.
 */
async function lockOwned(tx: Transaction, userId: string, id: string) {
  const [row] = await tx.select().from(playlists).where(eq(playlists.id, id)).for('update')
  return checkAccess(tx, userId, row, 'owner')
}

type ItemAccess = 'add' | 'edit' | 'owner'

async function checkAccess(
  client: Transaction | typeof db,
  userId: string,
  row: typeof playlists.$inferSelect | undefined,
  access: ItemAccess,
) {
  if (!row) throw playlistNotFound()
  if (row.ownerId === userId) return row
  const [member] = await client.select({ canEdit: playlistCollaborators.canEdit }).from(playlistCollaborators)
    .where(and(eq(playlistCollaborators.playlistId, row.id), eq(playlistCollaborators.userId, userId)))
  if (!row.isPublic && !member) throw playlistNotFound()
  if (access === 'owner') throw forbidden('Only the owner can change this playlist')
  if (!member || (access === 'edit' && !member.canEdit)) throw forbidden('You do not have permission to change these songs')
  return row
}

async function lockItems(tx: Transaction, userId: string, id: string, access: ItemAccess = 'edit') {
  const [row] = await tx.select().from(playlists).where(eq(playlists.id, id)).for('update')
  const playlist = await checkAccess(tx, userId, row, access)
  if (playlist.rules) throw smartPlaylistItems()
  return playlist
}

async function touch(tx: Transaction, id: string) {
  await tx.update(playlists).set({ updatedAt: new Date() }).where(eq(playlists.id, id))
}

async function collaboratorIds(client: Transaction | typeof db, id: string) {
  const members = await client.select({ id: playlistCollaborators.userId }).from(playlistCollaborators)
    .where(eq(playlistCollaborators.playlistId, id))
  return members.map((member) => member.id)
}

function playlistTargets(ids: readonly string[]) {
  return ids.length === 1 ? { user: ids[0]! } : ids.map((user) => ({ user }))
}

async function invalidatePlaylist(playlist: { id: string; ownerId: string; isPublic: boolean }, extra: string[] = []) {
  const users = [...new Set([playlist.ownerId, ...extra, ...await collaboratorIds(db, playlist.id)])]
  const targets = playlistTargets(users)
  const lists = [queryKeys.playlists(), queryKeys.libraryItems(), queryKeys.search()]
  if (!playlist.isPublic) {
    await invalidate(targets, [queryKeys.playlists(), queryKeys.libraryItems(), queryKeys.home(), queryKeys.search()])
    return
  }
  await invalidate([{ user: playlist.ownerId }, 'all'], lists)
  await invalidate(targets, [queryKeys.home()])
}

/** Creates an empty playlist owned by the user, who may own at most `PLAYLIST_LIMIT`; with `rules`, a smart one. */
export async function createPlaylist(
  userId: string,
  input: CreatePlaylistRequest,
  tracks: readonly { trackId: string; albumId: string | null }[] = [],
): Promise<PlaylistSummary> {
  const row = await db.transaction(async (tx) => {
    // One user's creates take turns, so concurrent ones cannot all pass the count.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`squirmy:playlists:${userId}`}, 0))`)
    if (await tx.$count(playlists, eq(playlists.ownerId, userId)) >= PLAYLIST_LIMIT) {
      throw conflict(`You can have at most ${PLAYLIST_LIMIT.toLocaleString('en')} playlists`, 'too_many_playlists')
    }
    const [row] = await tx.insert(playlists).values({
      id: newId(),
      ownerId: userId,
      name: input.name,
      description: input.description ?? null,
      isPublic: input.isPublic ?? false,
      rules: input.rules ?? null,
    }).returning()
    if (tracks.length) await insertItems(tx, userId, row!.id, 0, tracks)
    return row!
  })
  // A new playlist heads the Library's Recently played, as a play would.
  await recordCollectionAdd(userId, { type: 'playlist', id: row.id })
  await invalidatePlaylist(row)
  return (await playlistSummaries([row.id], userId))[0]!
}

/** Renames, re-describes or publishes a playlist, or changes a smart playlist's rules. Owner only. */
export async function updatePlaylist(userId: string, id: string, input: UpdatePlaylistRequest): Promise<PlaylistSummary> {
  const { before, after: updated } = await db.transaction(async (tx) => {
    if (input.folderId) {
      const [folder] = await tx.select({ id: playlistFolders.id }).from(playlistFolders)
        .where(and(eq(playlistFolders.id, input.folderId), eq(playlistFolders.ownerId, userId))).for('key share')
      if (!folder) throw notFound('No such playlist folder', 'playlist_folder_not_found')
    }
    const before = await lockOwned(tx, userId, id)
    if (input.rules && !before.rules) throw conflict('A playlist of songs can’t take rules; make a smart playlist instead', 'not_smart_playlist')
    const [updated] = await tx.update(playlists).set({
      folderId: input.folderId,
      name: input.name,
      description: input.description,
      isPublic: input.isPublic,
      rules: input.rules,
      updatedAt: new Date(),
    }).where(eq(playlists.id, id)).returning()
    return { before, after: updated! }
  })
  await invalidatePlaylist({ ...updated, isPublic: before.isPublic || updated.isPublic })
  return (await playlistSummaries([id], userId))[0]!
}

/** Deletes a playlist and its items. Owner only. */
export async function deletePlaylist(userId: string, id: string): Promise<void> {
  const { row, members } = await db.transaction(async (tx) => {
    const row = await lockOwned(tx, userId, id)
    const members = await collaboratorIds(tx, id)
    await tx.delete(playlists).where(eq(playlists.id, id))
    return { row, members }
  })
  // Before the lists: a page open on it closes rather than keep showing the old copy.
  await publishChanges(row.isPublic ? [{ user: userId }, 'all'] : playlistTargets([userId, ...members]), [{ kind: 'deleted', entity: 'playlist', ids: [id] }])
  await invalidatePlaylist(row, members)
}

/**
 * Appends tracks in request order. Unknown track ids fail the whole request with
 * `track_not_found`. Each item remembers the album it was added from: the one given, or
 * the album its summary would show. With `skipDuplicates`, tracks already in the
 * playlist or repeated in the request are left out. Fails with `playlist_full` when the
 * playlist would hold more than `PLAYLIST_ITEM_LIMIT`.
 */
export async function addPlaylistItems(
  userId: string,
  id: string,
  tracks: readonly { trackId: string; albumId?: string | null }[],
  options: { skipDuplicates?: boolean } = {},
): Promise<PlaylistDetail> {
  // Permission first, so a caller learns nothing about tracks from a playlist they cannot change.
  await checkItemAccess(userId, id, 'add')
  if (tracks.length > PLAYLIST_ITEM_LIMIT) throw playlistFull()
  const summaries = await alignedTrackSummaries(userId, tracks.map((track) => ({ id: track.trackId, albumId: track.albumId })))
  const unknown = tracks.filter((_, index) => !summaries[index]).map((track) => track.trackId)
  if (unknown.length > 0) throw badRequest('Some tracks do not exist', 'track_not_found', { ids: unknown })

  const playlist = await db.transaction(async (tx) => {
    const playlist = await lockItems(tx, userId, id, 'add')
    const present = await tx.select({ recordingId: playlistItems.recordingId, position: playlistItems.position }).from(playlistItems).where(eq(playlistItems.playlistId, id))
    const seen = new Set(options.skipDuplicates ? present.map((item) => item.recordingId) : [])
    const rows = summaries.flatMap((summary) => {
      if (!summary || seen.has(summary.id)) return []
      if (options.skipDuplicates) seen.add(summary.id)
      return [{ recordingId: summary.id, albumId: summary.album?.id ?? null }]
    })
    if (present.length + rows.length > PLAYLIST_ITEM_LIMIT) throw playlistFull()
    if (rows.length > 0) {
      const start = present.reduce((max, item) => Math.max(max, item.position + 1), 0)
      await insertItems(tx, userId, id, start, rows.map((row) => ({ trackId: row.recordingId, albumId: row.albumId })))
      await touch(tx, id)
    }
    return playlist
  })
  await invalidatePlaylist(playlist)
  return getPlaylist(userId, id)
}

async function checkItemAccess(userId: string, id: string, access: ItemAccess) {
  const row = await checkAccess(db, userId, (await db.select().from(playlists).where(eq(playlists.id, id)))[0], access)
  if (row.rules) throw smartPlaylistItems()
}

async function insertItems(tx: Transaction, userId: string, id: string, start: number, rows: readonly { trackId: string; albumId: string | null }[]) {
  await tx.insert(playlistItems).values(rows.map((row, index) => ({
    id: newId(), playlistId: id, position: start + index, recordingId: row.trackId, albumId: row.albumId, addedBy: userId,
  })))
}

async function setPositions(tx: Transaction, id: string, ids: readonly string[]) {
  // A catalog cascade can leave gaps; use ordinality to restore the dense order.
  await tx.execute(sql`
    update playlist_items i set position = moved.ordinality - 1
    from unnest(${uuidArray([...ids])}) with ordinality as moved(id, ordinality)
    where i.playlist_id = ${id} and i.id = moved.id and i.position <> moved.ordinality - 1`)
}

/** Resolves the destination against the currently locked order. */
export async function movePlaylistItem(userId: string, id: string, itemId: string, toIndex: number, anchor?: MovePlaylistItemRequest['anchor']): Promise<PlaylistDetail> {
  const playlist = await db.transaction(async (tx) => {
    const playlist = await lockItems(tx, userId, id)
    const order = (await tx.select({ id: playlistItems.id }).from(playlistItems)
      .where(eq(playlistItems.playlistId, id)).orderBy(playlistItems.position, playlistItems.id)).map((item) => item.id)
    const from = order.indexOf(itemId)
    if (from < 0) throw notFound('No such playlist item', 'playlist_item_not_found')
    order.splice(from, 1)
    const neighbor = anchor ? order.indexOf(anchor.itemId) : -1
    if (anchor && neighbor < 0) throw conflict('The destination song is gone. Try the move again.', 'playlist_changed')
    const to = anchor ? neighbor + Number(anchor.side === 'after') : Math.min(toIndex, order.length)
    if (from === to) return playlist
    order.splice(to, 0, itemId)
    await setPositions(tx, id, order)
    await touch(tx, id)
    return playlist
  })
  await invalidatePlaylist(playlist)
  return getPlaylist(userId, id)
}

/** Removes one item and closes the gap. */
export async function removePlaylistItem(userId: string, id: string, itemId: string): Promise<PlaylistDetail> {
  const playlist = await db.transaction(async (tx) => {
    const playlist = await lockItems(tx, userId, id)
    const [removed] = await tx.delete(playlistItems)
      .where(and(eq(playlistItems.id, itemId), eq(playlistItems.playlistId, id)))
      .returning({ position: playlistItems.position })
    if (!removed) throw notFound('No such playlist item', 'playlist_item_not_found')
    await tx.update(playlistItems).set({ position: sql`${playlistItems.position} - 1` })
      .where(and(eq(playlistItems.playlistId, id), sql`${playlistItems.position} > ${removed.position}`))
    await touch(tx, id)
    return playlist
  })
  await invalidatePlaylist(playlist)
  return getPlaylist(userId, id)
}


export type PlaylistItemSlot = { itemId: string } | { trackId: string; albumId?: string | null }

/**
 * Replaces the playlist's items with `slots`, in order. A slot with `itemId` keeps that
 * item (and when it was added); one with `trackId` adds a track as `addPlaylistItems`
 * would. Items not named are removed. Unknown tracks fail with `track_not_found`, items
 * of another playlist with `playlist_item_not_found`, more than `PLAYLIST_ITEM_LIMIT`
 * slots with `playlist_full`. Refuses stale snapshots.
 */
export async function replacePlaylistItems(userId: string, id: string, slots: readonly PlaylistItemSlot[], expectedIds: readonly string[], access: 'owner' | 'edit' = 'owner'): Promise<void> {
  await checkItemAccess(userId, id, access)
  if (slots.length > PLAYLIST_ITEM_LIMIT) throw playlistFull()
  const added = slots.flatMap((slot) => 'trackId' in slot ? [slot] : [])
  const summaries = await alignedTrackSummaries(userId, added.map((slot) => ({ id: slot.trackId, albumId: slot.albumId })))
  const unknown = added.filter((_, index) => !summaries[index]).map((slot) => slot.trackId)
  if (unknown.length > 0) throw badRequest('Some tracks do not exist', 'track_not_found', { ids: unknown })

  const playlist = await db.transaction(async (tx) => {
    const playlist = await lockItems(tx, userId, id, access)
    const current = await tx.select({ id: playlistItems.id }).from(playlistItems)
      .where(eq(playlistItems.playlistId, id)).orderBy(playlistItems.position, playlistItems.id)
    if (current.length !== expectedIds.length || current.some((item, index) => item.id !== expectedIds[index])) {
      throw conflict('The playlist changed. Reload it and try again.', 'playlist_changed')
    }
    const existing = new Set(expectedIds)
    const kept = slots.flatMap((slot, position) => 'itemId' in slot ? [{ id: slot.itemId, position }] : [])
    if (kept.some((item) => !existing.has(item.id)) || new Set(kept.map((item) => item.id)).size !== kept.length) {
      throw notFound('No such playlist item', 'playlist_item_not_found')
    }
    await tx.delete(playlistItems).where(and(
      eq(playlistItems.playlistId, id),
      sql`${playlistItems.id} <> all(${uuidArray(kept.map((item) => item.id))})`,
    ))
    if (kept.length > 0) {
      await tx.execute(sql`
        update playlist_items set position = moved.position
        from unnest(${uuidArray(kept.map((item) => item.id))}, ${`{${kept.map((item) => item.position).join(',')}}`}::int[]) as moved(id, position)
        where playlist_items.id = moved.id`)
    }
    let next = 0
    const inserts = slots.flatMap((slot, position) => {
      if (!('trackId' in slot)) return []
      const summary = summaries[next++]!
      return [{ id: newId(), playlistId: id, position, recordingId: summary.id, albumId: summary.album?.id ?? null, addedBy: userId }]
    })
    if (inserts.length > 0) await tx.insert(playlistItems).values(inserts)
    await touch(tx, id)
    return playlist
  })
  await invalidatePlaylist(playlist)
}

export async function listPlaylistFolders(userId: string): Promise<PlaylistFolder[]> {
  return db.select({ id: playlistFolders.id, name: playlistFolders.name }).from(playlistFolders)
    .where(eq(playlistFolders.ownerId, userId)).orderBy(playlistFolders.name, playlistFolders.id)
}

export async function createPlaylistFolder(userId: string, name: string): Promise<PlaylistFolder> {
  const folder = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`squirmy:playlist-folders:${userId}`}, 0))`)
    if (await tx.$count(playlistFolders, eq(playlistFolders.ownerId, userId)) >= PLAYLIST_LIMIT) {
      throw conflict('You have reached the playlist folder limit', 'too_many_playlist_folders')
    }
    const [row] = await tx.insert(playlistFolders).values({ id: newId(), ownerId: userId, name })
      .returning({ id: playlistFolders.id, name: playlistFolders.name })
    return row!
  })
  await invalidate({ user: userId }, [queryKeys.playlists()])
  return folder
}

export async function deletePlaylistFolder(userId: string, id: string): Promise<void> {
  const [folder] = await db.delete(playlistFolders)
    .where(and(eq(playlistFolders.ownerId, userId), eq(playlistFolders.id, id))).returning({ id: playlistFolders.id })
  if (!folder) throw notFound('No such playlist folder', 'playlist_folder_not_found')
  await invalidate({ user: userId }, [queryKeys.playlists(), queryKeys.libraryItems(), queryKeys.home()])
}

/** The owner can invite existing accounts directly. Expose names and handles for the picker. */
export async function playlistPeople(userId: string, id: string, search: string): Promise<PlaylistPerson[]> {
  await requirePlaylistOwner(userId, id)
  return db.execute<PlaylistPerson>(sql`
    select id, username, coalesce(display_name, username) as name from users where id <> ${userId}
      and (strpos(lower(username), lower(${search})) > 0 or strpos(lower(coalesce(display_name, '')), lower(${search})) > 0)
    order by lower(username), id limit 50`)
}

export async function listPlaylistCollaborators(userId: string, id: string): Promise<PlaylistCollaborator[]> {
  await requirePlaylistOwner(userId, id)
  return db.execute<PlaylistCollaborator>(sql`
    select u.id, u.username, coalesce(u.display_name, u.username) as name,
      case when c.can_edit then 'edit' else 'add' end as role
    from playlist_collaborators c join users u on u.id = c.user_id where c.playlist_id = ${id}
    order by lower(u.username), u.id`)
}

async function requirePlaylistOwner(userId: string, id: string) {
  return checkAccess(db, userId, (await db.select().from(playlists).where(eq(playlists.id, id)))[0], 'owner')
}

export async function setPlaylistCollaborator(userId: string, id: string, collaboratorId: string, role: PlaylistCollaboratorRole | null) {
  const changed = await db.transaction(async (tx) => {
    const playlist = await lockItems(tx, userId, id, 'owner')
    if (userId === collaboratorId) throw badRequest('You already own this playlist', 'playlist_owner')
    const key = and(eq(playlistCollaborators.playlistId, id), eq(playlistCollaborators.userId, collaboratorId))
    const [before] = await tx.select().from(playlistCollaborators).where(key)
    if (role === null) {
      if (!before) return null
      await tx.delete(playlistCollaborators).where(key)
    } else {
      const canEdit = role === 'edit'
      if (before?.canEdit === canEdit) return null
      const [user] = await tx.select({ id: users.id }).from(users).where(eq(users.id, collaboratorId)).for('key share')
      if (!user) throw notFound('No such user', 'user_not_found')
      await tx.insert(playlistCollaborators).values({ playlistId: id, userId: collaboratorId, canEdit })
        .onConflictDoUpdate({ target: [playlistCollaborators.playlistId, playlistCollaborators.userId], set: { canEdit } })
    }
    return playlist
  })
  if (changed) {
    if (role === null && !changed.isPublic) {
      await publishChanges({ user: collaboratorId }, [{ kind: 'deleted', entity: 'playlist', ids: [id] }])
    }
    await invalidatePlaylist(changed, [collaboratorId])
  }
}

export async function setPlaylistCover(userId: string, id: string, bytes: Uint8Array | null): Promise<PlaylistSummary> {
  await requirePlaylistOwner(userId, id)
  const artworkAssetId = bytes ? (await storeImage(bytes, { kind: 'cover', source: `upload:playlist:${id}` })).id : null
  const playlist = await db.transaction(async (tx) => {
    const playlist = await lockOwned(tx, userId, id)
    await tx.update(playlists).set({ artworkAssetId, updatedAt: new Date() }).where(eq(playlists.id, id))
    return playlist
  })
  await invalidatePlaylist(playlist)
  return (await playlistSummaries([id], userId))[0]!
}

export async function dedupePlaylist(userId: string, id: string, editions: boolean): Promise<PlaylistDedupeResult> {
  const { playlist, removed } = await db.transaction(async (tx) => {
    const playlist = await lockItems(tx, userId, id)
    const items = await tx.execute<{ id: string; recordingId: string; title: string; artist: string }>(sql`
      select i.id, i.recording_id as "recordingId", r.title, r.artist_credit as artist
      from playlist_items i join recordings r on r.id = i.recording_id
      where i.playlist_id = ${id} order by i.position, i.id`)
    const seen = new Set<string>()
    const copies: string[] = []
    const kept: string[] = []
    for (const item of items) {
      const title = editions && editionFreeKey(item.title)
      const artist = editions && matchKey(item.artist)
      const key = title && artist ? `${artist}|${title}` : item.recordingId
      if (seen.has(key)) copies.push(item.id)
      else kept.push(item.id)
      seen.add(key)
    }
    if (copies.length) {
      await tx.execute(sql`delete from playlist_items where playlist_id = ${id} and id = any(${uuidArray(copies)})`)
      await setPositions(tx, id, kept)
      await touch(tx, id)
    }
    return { playlist, removed: copies.length }
  })
  if (removed) await invalidatePlaylist(playlist)
  return { removed, playlist: await getPlaylist(userId, id) }
}
