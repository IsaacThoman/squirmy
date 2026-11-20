/**
 * Playlists, through the userdata service. Subsonic clients only see the tracks the
 * server can play, so counts, durations and song indexes are over those, and edits keep
 * the hidden tracks: `songIndexToRemove=1` removes the second playable track, and an
 * overwrite (createPlaylist with `playlistId`) fills the playable slots in order.
 */
import { sql } from 'drizzle-orm'
import { db } from '../../../database/client.js'
import { isoTime, uuidArray } from '../../catalog/sql.js'
import { resolveMerged } from '../../catalog/redirects.js'
import { trackAvailability } from '../../catalog/availability.js'
import { usernameKey } from '../../auth/service.js'
import {
  addPlaylistItems, createPlaylist, deletePlaylist, replacePlaylistItems, updatePlaylist, type PlaylistItemSlot,
} from '../../userdata/playlists.js'
import { coverArtId, expectId, playlistId } from '../ids.js'
import { invalidParameter, missingParameter, notAuthorized, notFound, type Context, type Handler, type Payload } from '../protocol.js'
import { songs } from '../songs.js'
import { seconds } from '../sql.js'

type PlaylistRow = {
  id: string
  name: string
  description: string | null
  ownerId: string
  owner: string
  isPublic: boolean
  created: string
  changed: string
  songCount: number
  durationMs: number | string
  artworkId: string | null
}

/** Playlists the user can see (their own and public ones), or all of `ownerId`'s (for admins), newest change first. */
async function playlistRows(userId: string, filter: { ids?: string[]; ownerId?: string }): Promise<PlaylistRow[]> {
  return db.execute<PlaylistRow>(sql`
    select p.id, p.name, p.description, p.owner_id as "ownerId", u.username as owner, p.is_public as "isPublic",
      ${isoTime('p.created_at')} as created, ${isoTime('p.updated_at')} as changed,
      stats."songCount", stats."durationMs", cover.id as "artworkId"
    from playlists p
    join users u on u.id = p.owner_id
    cross join lateral (
      select count(*)::int as "songCount", coalesce(sum(r.duration_ms), 0)::int8 as "durationMs"
      from playlist_items i join recordings r on r.id = i.recording_id
      where i.playlist_id = p.id
        and exists (select 1 from media_files f where f.recording_id = i.recording_id and f.missing_since is null)
    ) stats
    left join lateral (
      select a.artwork_asset_id as id from playlist_items i join albums a on a.id = i.album_id
      where i.playlist_id = p.id and a.artwork_asset_id is not null order by i.position limit 1
    ) cover on true
    where ${filter.ownerId ? sql`p.owner_id = ${filter.ownerId}` : sql`(p.owner_id = ${userId} or p.is_public)`}
      ${filter.ids ? sql`and p.id = any(${uuidArray(filter.ids)})` : sql``}
    order by p.updated_at desc, p.id desc`)
}

function toPlaylist(row: PlaylistRow, userId: string): Payload {
  return {
    id: playlistId(row.id),
    name: row.name,
    comment: row.description ?? undefined,
    owner: row.owner,
    public: row.isPublic,
    songCount: row.songCount,
    duration: seconds(Number(row.durationMs)),
    created: row.created,
    changed: row.changed,
    coverArt: row.artworkId ? coverArtId(row.artworkId) : undefined,
    readonly: row.ownerId !== userId,
  }
}

/** Every item in order, with whether the server can play it (what Subsonic clients see). */
async function playlistItems(id: string) {
  const items = await db.execute<{ itemId: string; recordingId: string; albumId: string | null }>(sql`
    select id as "itemId", recording_id as "recordingId", album_id as "albumId" from playlist_items
    where playlist_id = ${id} order by position`)
  const resolved = await resolveMerged('recordings', items.map((item) => item.recordingId))
  const availability = await trackAvailability([...resolved.values()])
  return items.map((item) => ({ ...item, visible: availability.get(resolved.get(item.recordingId) ?? '') === 'server' }))
}

async function readPlaylist(userId: string, value: string): Promise<PlaylistRow> {
  const [row] = await playlistRows(userId, { ids: [expectId(value, 'playlist').id] })
  if (!row) throw notFound('Playlist')
  return row
}

async function playlistWithSongs(userId: string, id: string): Promise<Payload> {
  const [row] = await playlistRows(userId, { ids: [id] })
  if (!row) throw notFound('Playlist')
  const items = (await playlistItems(id)).filter((item) => item.visible)
  return { ...toPlaylist(row, userId), entry: await songs(userId, items.map((item) => ({ id: item.recordingId, albumId: item.albumId }))) }
}

/**
 * The playlist's full item list after the visible part became `visible`: hidden items
 * keep their places, visible slots take the new list in order, and the rest goes last.
 */
export function mergeVisible(items: readonly { itemId: string; visible: boolean }[], visible: readonly PlaylistItemSlot[]): PlaylistItemSlot[] {
  const pending = [...visible]
  const merged: PlaylistItemSlot[] = []
  for (const item of items) {
    if (!item.visible) merged.push({ itemId: item.itemId })
    else if (pending.length > 0) merged.push(pending.shift()!)
  }
  return [...merged, ...pending]
}

const songIds = (values: readonly string[]) => values.map((value) => expectId(value, 'track').id)

async function createOrOverwrite({ user, params }: Context): Promise<Payload> {
  const tracks = songIds(params.all('songId'))
  const existing = params.string('playlistId')
  if (existing) {
    const row = await readPlaylist(user.id, existing)
    if (row.ownerId !== user.id) throw notAuthorized()
    const name = params.string('name')
    if (name) await updatePlaylist(user.id, row.id, { name })
    // Tracks already in the playlist keep their items, and with them when they were added.
    const items = await playlistItems(row.id)
    const reusable = new Map<string, string[]>()
    for (const item of items.filter((candidate) => candidate.visible)) {
      const list = reusable.get(item.recordingId) ?? []
      list.push(item.itemId)
      reusable.set(item.recordingId, list)
    }
    const visible = tracks.map((trackId): PlaylistItemSlot => {
      const itemId = reusable.get(trackId)?.shift()
      return itemId ? { itemId } : { trackId }
    })
    await replacePlaylistItems(user.id, row.id, mergeVisible(items, visible))
    return { playlist: await playlistWithSongs(user.id, row.id) }
  }
  const name = params.string('name')
  if (!name) throw missingParameter('name')
  const created = await createPlaylist(user.id, { name: name.slice(0, 120) })
  if (tracks.length > 0) await addPlaylistItems(user.id, created.id, tracks.map((trackId) => ({ trackId })))
  return { playlist: await playlistWithSongs(user.id, created.id) }
}

async function updatePlaylistHandler({ user, params }: Context): Promise<Payload> {
  const row = await readPlaylist(user.id, params.required('playlistId'))
  if (row.ownerId !== user.id) throw notAuthorized()
  const name = params.string('name')
  const comment = params.string('comment')
  const isPublic = params.bool('public')
  if (name !== undefined || comment !== undefined || isPublic !== undefined) {
    await updatePlaylist(user.id, row.id, {
      name: name ? name.slice(0, 120) : undefined,
      description: comment === undefined ? undefined : comment || null,
      isPublic,
    })
  }
  const added = songIds(params.all('songIdToAdd'))
  const removed = new Set(params.all('songIndexToRemove').map((value) => {
    if (!/^\d+$/.test(value)) throw invalidParameter('songIndexToRemove')
    return Number(value)
  }))
  if (added.length > 0 || removed.size > 0) {
    const items = await playlistItems(row.id)
    const visible = items.filter((item) => item.visible)
    if ([...removed].some((index) => index >= visible.length)) throw invalidParameter('songIndexToRemove')
    const removedIds = new Set(visible.filter((_, index) => removed.has(index)).map((item) => item.itemId))
    const kept = items.filter((item) => !removedIds.has(item.itemId)).map((item): PlaylistItemSlot => ({ itemId: item.itemId }))
    await replacePlaylistItems(user.id, row.id, [...kept, ...added.map((trackId) => ({ trackId }))])
  }
  return {}
}

export const playlistEndpoints: Record<string, Handler> = {
  getPlaylists: async ({ user, params }) => {
    const username = params.string('username')
    let ownerId: string | undefined
    if (username && usernameKey(username) !== user.usernameKey) {
      if (user.role !== 'admin') throw notAuthorized()
      const [owner] = await db.execute<{ id: string }>(sql`select id from users where username_key = ${usernameKey(username)}`)
      if (!owner) throw notFound('User')
      ownerId = owner.id
    }
    const rows = await playlistRows(user.id, { ownerId })
    return { playlists: { playlist: rows.map((row) => toPlaylist(row, user.id)) } }
  },
  getPlaylist: async ({ user, params }) => ({ playlist: await playlistWithSongs(user.id, expectId(params.required('id'), 'playlist').id) }),
  createPlaylist: createOrOverwrite,
  updatePlaylist: updatePlaylistHandler,
  deletePlaylist: async ({ user, params }) => {
    const row = await readPlaylist(user.id, params.required('id'))
    if (row.ownerId !== user.id) throw notAuthorized()
    await deletePlaylist(user.id, row.id)
    return {}
  },
}
