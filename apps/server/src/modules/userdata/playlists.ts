/**
 * Playlists. Items point at recordings (plus the album they were added from), so they
 * survive re-rips and keep tracks that are not owned; those render gray.
 *
 * `playlist_items.position` is dense and 0-based. Every change to the items locks the
 * playlist row first, so concurrent adds, moves and removals serialize.
 */
import {
  queryKeys,
  type CreatePlaylistRequest, type PageQuery, type PlaylistDetail, type PlaylistPage, type PlaylistSummary, type UpdatePlaylistRequest,
} from '@squirmy/contracts'
import { and, eq, sql } from 'drizzle-orm'
import { db, type Transaction } from '../../database/client.js'
import { playlistItems, playlists } from '../../database/schema.js'
import { badRequest, forbidden, notFound } from '../../lib/errors.js'
import { newId } from '../../lib/ids.js'
import { invalidate } from '../../realtime/index.js'
import { after, cursorKeys, orderBy, toPage, type Ordering } from '../catalog/pagination.js'
import { isoTime, uuidArray } from '../catalog/sql.js'
import { alignedTrackSummaries } from '../catalog/summaries.js'

const playlistNotFound = () => notFound('No such playlist', 'playlist_not_found')

/** Summaries of playlists in input order, leaving out ids that do not exist. Does not check access. */
export async function playlistSummaries(ids: readonly string[]): Promise<PlaylistSummary[]> {
  if (ids.length === 0) return []
  const rows = await db.execute<Omit<PlaylistSummary, 'durationMs'> & { durationMs: number | string }>(sql`
    select p.id, p.name, p.description, p.owner_id as "ownerId", coalesce(u.display_name, u.username) as "ownerName",
      p.is_public as "isPublic", ${isoTime('p.updated_at')} as "updatedAt",
      stats."trackCount", stats."durationMs", covers.artworks
    from playlists p
    join users u on u.id = p.owner_id
    cross join lateral (
      select count(*)::int as "trackCount", coalesce(sum(r.duration_ms), 0)::int8 as "durationMs"
      from playlist_items i join recordings r on r.id = i.recording_id where i.playlist_id = p.id
    ) stats
    cross join lateral (
      select coalesce(json_agg(json_build_object('id', c.id, 'color', c.color, 'thumbhash', c.thumbhash) order by c.first), '[]'::json) as artworks
      from (
        select art.id, art.color, art.thumbhash, min(i.position) as first
        from playlist_items i join albums al on al.id = i.album_id join assets art on art.id = al.artwork_asset_id
        where i.playlist_id = p.id
        group by al.id, art.id
        order by first limit 4
      ) c
    ) covers
    where p.id = any(${uuidArray([...new Set(ids)])})`)
  const byId = new Map(rows.map((row) => [row.id, { ...row, durationMs: Number(row.durationMs) }]))
  return ids.flatMap((id) => byId.get(id) ?? [])
}

const playlistOrdering: Ordering = {
  name: 'playlists:updated',
  keys: [
    { expression: sql.raw('p.updated_at'), type: 'timestamptz', descending: true },
    { expression: sql.raw('p.id'), type: 'uuid', descending: true },
  ],
}

/** One page of the playlists the user can see (theirs and other users' public ones), or only theirs. */
export async function listPlaylists(userId: string, query: PageQuery, options: { ownOnly?: boolean } = {}): Promise<PlaylistPage> {
  const visible = options.ownOnly ? sql`p.owner_id = ${userId}` : sql`(p.owner_id = ${userId} or p.is_public)`
  const rows = await db.execute<{ id: string; cursorKeys: string[] }>(sql`
    select p.id, ${cursorKeys(playlistOrdering)} from playlists p
    where ${visible} and ${after(playlistOrdering, query.cursor)}
    order by ${orderBy(playlistOrdering)} limit ${query.limit + 1}`)
  return toPage(playlistOrdering, rows, query.limit, await playlistSummaries(rows.slice(0, query.limit).map((row) => row.id)))
}

/** A playlist with its items. Readable by its owner, and by anyone when public; 404 otherwise. */
export async function getPlaylist(userId: string, id: string): Promise<PlaylistDetail> {
  const [summary] = await playlistSummaries([id])
  if (!summary || (summary.ownerId !== userId && !summary.isPublic)) throw playlistNotFound()
  const items = await db.execute<{ id: string; recordingId: string; albumId: string | null; addedAt: string }>(sql`
    select id, recording_id as "recordingId", album_id as "albumId", ${isoTime('added_at')} as "addedAt"
    from playlist_items where playlist_id = ${id} order by position`)
  const tracks = await alignedTrackSummaries(userId, items.map((item) => ({ id: item.recordingId, albumId: item.albumId })))
  return {
    ...summary,
    items: items.flatMap((item, index) => {
      const track = tracks[index]
      return track ? [{ itemId: item.id, addedAt: item.addedAt, track }] : []
    }),
  }
}

/**
 * Locks a playlist for a change by `userId`. A playlist the user cannot see is 404; a
 * public one they do not own is 403.
 */
async function lockOwned(tx: Transaction, userId: string, id: string) {
  const [row] = await tx.select().from(playlists).where(eq(playlists.id, id)).for('update')
  return checkOwner(userId, row)
}

function checkOwner(userId: string, row: typeof playlists.$inferSelect | undefined) {
  if (!row || (row.ownerId !== userId && !row.isPublic)) throw playlistNotFound()
  if (row.ownerId !== userId) throw forbidden('Only the owner can change this playlist')
  return row
}

async function touch(tx: Transaction, id: string) {
  await tx.update(playlists).set({ updatedAt: new Date() }).where(eq(playlists.id, id))
}

/** Refreshes the owner's devices, and everyone's playlist lists when the playlist is or was public. */
async function invalidatePlaylist(ownerId: string, isPublic: boolean) {
  if (!isPublic) {
    await invalidate({ user: ownerId }, [queryKeys.playlists(), queryKeys.home()])
    return
  }
  // One target list reaches each socket once; the owner is in 'all' as well and would
  // otherwise refetch the playlists twice.
  await invalidate([{ user: ownerId }, 'all'], [queryKeys.playlists()])
  await invalidate({ user: ownerId }, [queryKeys.home()])
}

/** Creates an empty playlist owned by the user. */
export async function createPlaylist(userId: string, input: CreatePlaylistRequest): Promise<PlaylistSummary> {
  const [row] = await db.insert(playlists).values({
    id: newId(),
    ownerId: userId,
    name: input.name,
    description: input.description ?? null,
    isPublic: input.isPublic ?? false,
  }).returning()
  await invalidatePlaylist(userId, row!.isPublic)
  return (await playlistSummaries([row!.id]))[0]!
}

/** Renames, re-describes or publishes a playlist. Owner only. */
export async function updatePlaylist(userId: string, id: string, input: UpdatePlaylistRequest): Promise<PlaylistSummary> {
  const { before, after: updated } = await db.transaction(async (tx) => {
    const before = await lockOwned(tx, userId, id)
    const [updated] = await tx.update(playlists).set({
      name: input.name,
      description: input.description,
      isPublic: input.isPublic,
      updatedAt: new Date(),
    }).where(eq(playlists.id, id)).returning()
    return { before, after: updated! }
  })
  await invalidatePlaylist(userId, before.isPublic || updated.isPublic)
  return (await playlistSummaries([id]))[0]!
}

/** Deletes a playlist and its items. Owner only. */
export async function deletePlaylist(userId: string, id: string): Promise<void> {
  const row = await db.transaction(async (tx) => {
    const row = await lockOwned(tx, userId, id)
    await tx.delete(playlists).where(eq(playlists.id, id))
    return row
  })
  await invalidatePlaylist(userId, row.isPublic)
}

/**
 * Appends tracks in request order. Unknown track ids fail the whole request with
 * `track_not_found`. Each item remembers the album it was added from: the one given, or
 * the album its summary would show. With `skipDuplicates`, tracks already in the
 * playlist or repeated in the request are left out. Owner only.
 */
export async function addPlaylistItems(
  userId: string,
  id: string,
  tracks: readonly { trackId: string; albumId?: string | null }[],
  options: { skipDuplicates?: boolean } = {},
): Promise<PlaylistDetail> {
  // Permission first, so a caller learns nothing about tracks from a playlist they cannot change.
  checkOwner(userId, (await db.select().from(playlists).where(eq(playlists.id, id)))[0])
  const summaries = await alignedTrackSummaries(userId, tracks.map((track) => ({ id: track.trackId, albumId: track.albumId })))
  const unknown = tracks.filter((_, index) => !summaries[index]).map((track) => track.trackId)
  if (unknown.length > 0) throw badRequest('Some tracks do not exist', 'track_not_found', { ids: unknown })

  const playlist = await db.transaction(async (tx) => {
    const playlist = await lockOwned(tx, userId, id)
    const present = await tx.select({ recordingId: playlistItems.recordingId }).from(playlistItems).where(eq(playlistItems.playlistId, id))
    const seen = new Set(options.skipDuplicates ? present.map((item) => item.recordingId) : [])
    const rows = summaries.flatMap((summary) => {
      if (!summary || seen.has(summary.id)) return []
      if (options.skipDuplicates) seen.add(summary.id)
      return [{ recordingId: summary.id, albumId: summary.album?.id ?? null }]
    })
    const start = present.length
    if (rows.length > 0) {
      await tx.insert(playlistItems).values(rows.map((row, index) => ({
        id: newId(), playlistId: id, position: start + index, recordingId: row.recordingId, albumId: row.albumId, addedBy: userId,
      })))
      await touch(tx, id)
    }
    return playlist
  })
  await invalidatePlaylist(userId, playlist.isPublic)
  return getPlaylist(userId, id)
}

/** Moves an item to `toIndex` (clamped to the end), shifting the items between. Owner only. */
export async function movePlaylistItem(userId: string, id: string, itemId: string, toIndex: number): Promise<PlaylistDetail> {
  const playlist = await db.transaction(async (tx) => {
    const playlist = await lockOwned(tx, userId, id)
    const [item] = await tx.select({ position: playlistItems.position }).from(playlistItems)
      .where(and(eq(playlistItems.id, itemId), eq(playlistItems.playlistId, id)))
    if (!item) throw notFound('No such playlist item', 'playlist_item_not_found')
    const [counted] = await tx.select({ count: sql<number>`count(*)::int` }).from(playlistItems).where(eq(playlistItems.playlistId, id))
    const from = item.position
    const to = Math.min(toIndex, counted!.count - 1)
    if (from === to) return playlist
    await tx.update(playlistItems).set({
      position: from < to ? sql`${playlistItems.position} - 1` : sql`${playlistItems.position} + 1`,
    }).where(and(
      eq(playlistItems.playlistId, id),
      sql`${playlistItems.position} between ${Math.min(from, to)} and ${Math.max(from, to)}`,
      sql`${playlistItems.id} <> ${itemId}`,
    ))
    await tx.update(playlistItems).set({ position: to }).where(eq(playlistItems.id, itemId))
    await touch(tx, id)
    return playlist
  })
  await invalidatePlaylist(userId, playlist.isPublic)
  return getPlaylist(userId, id)
}

/** Removes one item and closes the gap. Owner only. */
export async function removePlaylistItem(userId: string, id: string, itemId: string): Promise<PlaylistDetail> {
  const playlist = await db.transaction(async (tx) => {
    const playlist = await lockOwned(tx, userId, id)
    const [removed] = await tx.delete(playlistItems)
      .where(and(eq(playlistItems.id, itemId), eq(playlistItems.playlistId, id)))
      .returning({ position: playlistItems.position })
    if (!removed) throw notFound('No such playlist item', 'playlist_item_not_found')
    await tx.update(playlistItems).set({ position: sql`${playlistItems.position} - 1` })
      .where(and(eq(playlistItems.playlistId, id), sql`${playlistItems.position} > ${removed.position}`))
    await touch(tx, id)
    return playlist
  })
  await invalidatePlaylist(userId, playlist.isPublic)
  return getPlaylist(userId, id)
}


export type PlaylistItemSlot = { itemId: string } | { trackId: string; albumId?: string | null }

/**
 * Replaces the playlist's items with `slots`, in order. A slot with `itemId` keeps that
 * item (and when it was added); one with `trackId` adds a track as `addPlaylistItems`
 * would. Items not named are removed. Unknown tracks fail with `track_not_found`, items
 * of another playlist with `playlist_item_not_found`. Owner only.
 */
export async function replacePlaylistItems(userId: string, id: string, slots: readonly PlaylistItemSlot[]): Promise<void> {
  checkOwner(userId, (await db.select().from(playlists).where(eq(playlists.id, id)))[0])
  const added = slots.flatMap((slot) => 'trackId' in slot ? [slot] : [])
  const summaries = await alignedTrackSummaries(userId, added.map((slot) => ({ id: slot.trackId, albumId: slot.albumId })))
  const unknown = added.filter((_, index) => !summaries[index]).map((slot) => slot.trackId)
  if (unknown.length > 0) throw badRequest('Some tracks do not exist', 'track_not_found', { ids: unknown })

  const playlist = await db.transaction(async (tx) => {
    const playlist = await lockOwned(tx, userId, id)
    const existing = new Set((await tx.select({ id: playlistItems.id }).from(playlistItems).where(eq(playlistItems.playlistId, id))).map((row) => row.id))
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
  await invalidatePlaylist(userId, playlist.isPublic)
}
