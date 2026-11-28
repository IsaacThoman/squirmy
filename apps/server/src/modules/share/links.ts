/**
 * Share links: making, listing and revoking them, and finding the live link behind a token.
 *
 * A token is 32 random bytes (base64url) and only its SHA-256 is stored, as with sessions, so
 * the link is shown once, when it is made. Every way a link stops working (unknown, expired,
 * revoked, its creator disabled, a playlist made private, sharing switched off) answers the
 * same 404, so a request cannot tell which.
 */
import {
  SHARE_LIMIT, queryKeys,
  type CreateShareRequest, type PageQuery, type ShareExpiry, type ShareKind, type ShareLink, type ShareLinkPage,
} from '@squirmy/contracts'
import { and, eq, sql } from 'drizzle-orm'
import { db } from '../../database/client.js'
import { playlists, shares, users } from '../../database/schema.js'
import { hashToken, randomToken } from '../../lib/crypto.js'
import { AppError, conflict, notFound } from '../../lib/errors.js'
import { newId } from '../../lib/ids.js'
import { getServerSettings } from '../../lib/settings.js'
import { invalidate } from '../../realtime/index.js'
import { after, cursorKeys, orderBy, toPage, type Ordering } from '../catalog/pagination.js'
import { albumTrackList } from '../catalog/pages.js'
import { resolveMerged, resolveOne } from '../catalog/redirects.js'
import { uuidArray } from '../catalog/sql.js'
import { albumSummaries, alignedTrackSummaries, type TrackRef } from '../catalog/summaries.js'
import { shownVersion } from '../catalog/versions.js'
import { playlistSummaries, playlistTrackRefs } from '../userdata/playlists.js'

export type ShareRow = typeof shares.$inferSelect

const DAY_MS = 24 * 60 * 60_000
/**
 * `never` is allowed: a link is revocable by its creator and by admins, dies with the account
 * and the item, and every link stops at once when the operator turns sharing off. A link for a
 * friend's playlist that keeps working is what people expect from other music apps.
 */
const expiryMs: Record<ShareExpiry, number | null> = { '1d': DAY_MS, '7d': 7 * DAY_MS, '30d': 30 * DAY_MS, never: null }

/** Expired links stay listed (as expired) this long, then the sweep deletes them. */
export const EXPIRED_KEPT_MS = 30 * DAY_MS

/** The one answer for every link that does not work. */
export const shareNotFound = () => notFound('This link does not work. It may have expired or been revoked.', 'share_not_found')

/** Tokens are 43 base64url characters; anything else cannot be one, and gets the same 404. */
const tokenShape = /^[A-Za-z0-9_-]{43}$/

/**
 * Conditions every live link meets, over `shares s`: not expired, made by an enabled account,
 * and for a playlist, one its creator can still see. The operator's switch is checked apart.
 */
const live = sql`(s.expires_at is null or s.expires_at > now())
  and exists (select 1 from users u where u.id = s.user_id and u.disabled_at is null)
  and (s.kind <> 'playlist' or exists (
    select 1 from playlists p where p.id = s.playlist_id and (p.owner_id = s.user_id or p.is_public)))`

async function liveShare(where: ReturnType<typeof sql>): Promise<ShareRow> {
  if (!(await getServerSettings()).sharingEnabled) throw shareNotFound()
  const [row] = await db.execute<{ id: string }>(sql`select s.id from shares s where ${where} and ${live}`)
  if (!row) throw shareNotFound()
  const [share] = await db.select().from(shares).where(eq(shares.id, row.id))
  if (!share) throw shareNotFound()
  return share
}

/** The live link a token names, or the uniform 404. */
export async function shareForToken(token: string): Promise<ShareRow> {
  if (!tokenShape.test(token)) throw shareNotFound()
  return liveShare(sql`s.token_hash = ${hashToken(token)}`)
}

/** The live link with this id (from a signed stream URL), or the uniform 404. */
export async function shareForId(id: string): Promise<ShareRow> {
  return liveShare(sql`s.id = ${id}`)
}

/** Counts an opening of the public page. */
export async function recordOpen(shareId: string) {
  await db.update(shares).set({ openCount: sql`${shares.openCount} + 1`, lastOpenedAt: new Date() }).where(eq(shares.id, shareId))
}

/**
 * The songs of a shared item now, in order, as refs for `alignedTrackSummaries`: an album's
 * track list (of the edition its creator's page lists, `shownVersion`), a playlist's current songs (the page follows the playlist, it is not a copy;
 * a smart playlist's are what its rules find for its owner), or the one track.
 */
export async function shareTracks(share: ShareRow): Promise<(TrackRef & { disc: number | null; position: number | null })[]> {
  if (share.kind === 'album') {
    const albumId = (await resolveOne('albums', share.albumId!)) ?? share.albumId!
    const { editionId } = await shownVersion(share.userId, albumId)
    return (await albumTrackList(albumId, editionId)).map((track) => ({ id: track.recordingId, albumId, disc: track.disc, position: track.position }))
  }
  if (share.kind === 'playlist') {
    const items = await playlistTrackRefs(share.playlistId!)
    return items.map((item) => ({ id: item.recordingId, albumId: item.albumId, disc: null, position: null }))
  }
  return [{ id: share.recordingId!, albumId: share.albumId, disc: null, position: null }]
}

/** The ref of a track (by its current id) when the shared item holds it now. */
export async function shareTrack(share: ShareRow, trackId: string): Promise<TrackRef | null> {
  const refs = await shareTracks(share)
  const current = await resolveMerged('recordings', refs.map((ref) => ref.id))
  return refs.find((ref) => (current.get(ref.id) ?? ref.id) === trackId) ?? null
}

const tooMany = () => conflict(`You can have at most ${SHARE_LIMIT} share links. Revoke some first.`, 'too_many_shares')

/** What a link points at, checked for the user making it. Throws the item's own 404. */
async function target(userId: string, input: CreateShareRequest): Promise<Pick<ShareRow, 'kind' | 'albumId' | 'playlistId' | 'recordingId'>> {
  if (input.kind === 'album') {
    const albumId = await resolveOne('albums', input.id)
    if (!albumId) throw notFound('No such album', 'album_not_found')
    return { kind: 'album', albumId, playlistId: null, recordingId: null }
  }
  if (input.kind === 'playlist') {
    const [playlist] = await db.select({ ownerId: playlists.ownerId, isPublic: playlists.isPublic }).from(playlists).where(eq(playlists.id, input.id))
    if (!playlist || (playlist.ownerId !== userId && !playlist.isPublic)) throw notFound('No such playlist', 'playlist_not_found')
    return { kind: 'playlist', albumId: null, playlistId: input.id, recordingId: null }
  }
  const [recordingId, albumId] = await Promise.all([
    resolveOne('recordings', input.id),
    input.albumId ? resolveOne('albums', input.albumId) : null,
  ])
  if (!recordingId) throw notFound('No such track', 'track_not_found')
  return { kind: 'track', albumId, playlistId: null, recordingId }
}

/** Tells the creator's open screens and the admins' that the links changed. */
async function announce(userId: string) {
  await invalidate([{ user: userId }, 'admins'], [queryKeys.shares(), queryKeys.adminShares()])
}

/** `POST /me/shares`. The answer carries the link's path, which is never shown again. */
export async function createShare(userId: string, input: CreateShareRequest): Promise<ShareLink> {
  if (!(await getServerSettings()).sharingEnabled) throw new AppError(403, 'sharing_disabled', 'Sharing is turned off on this server')
  const values = await target(userId, input)
  const token = randomToken()
  const ttl = expiryMs[input.expiresIn]
  const row = await db.transaction(async (tx) => {
    // Two creates racing must not both slip under the limit.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`squirmy:shares:${userId}`}))`)
    const [{ count } = { count: 0 }] = await tx.execute<{ count: number }>(sql`select count(*)::int as count from shares where user_id = ${userId}`)
    if (count >= SHARE_LIMIT) throw tooMany()
    const [inserted] = await tx.insert(shares).values({
      id: newId(), tokenHash: hashToken(token), userId, ...values,
      expiresAt: ttl === null ? null : new Date(Date.now() + ttl),
    }).returning()
    return inserted!
  })
  await announce(userId)
  const [link] = await describe(userId, [row], false)
  return { ...link!, url: `/s/${token}` }
}

/** `DELETE /me/shares/:id` (own links only) and `DELETE /admin/shares/:id` (any). */
export async function revokeShare(id: string, userId: string | null) {
  const where = userId ? and(eq(shares.id, id), eq(shares.userId, userId)) : eq(shares.id, id)
  const [deleted] = await db.delete(shares).where(where).returning({ userId: shares.userId })
  if (!deleted) throw notFound('No such share link', 'share_link_not_found')
  await announce(deleted.userId)
}

const ordering: Ordering = {
  name: 'shares:created',
  keys: [
    { expression: sql.raw('s.created_at'), type: 'timestamptz', descending: true },
    { expression: sql.raw('s.id'), type: 'uuid', descending: true },
  ],
}

/** `GET /me/shares` (one user's) or `GET /admin/shares` (everyone's, with who made each), newest first. */
export async function listShares(viewerId: string, query: PageQuery, options: { all: boolean }): Promise<ShareLinkPage> {
  const rows = await db.execute<{ id: string; cursorKeys: string[] }>(sql`
    select s.id, ${cursorKeys(ordering)} from shares s
    where ${options.all ? sql`true` : sql`s.user_id = ${viewerId}`} and ${after(ordering, query.cursor)}
    order by ${orderBy(ordering)} limit ${query.limit + 1}`)
  const ids = rows.slice(0, query.limit).map((row) => row.id)
  const found = ids.length ? await db.select().from(shares).where(sql`${shares.id} = any(${uuidArray(ids)})`) : []
  const byId = new Map(found.map((row) => [row.id, row]))
  return toPage(ordering, rows, query.limit, await describe(viewerId, ids.flatMap((id) => byId.get(id) ?? []), options.all))
}

/** The rows as `ShareLink`s, in order, with the title, artist and cover of what each points at. */
async function describe(viewerId: string, rows: ShareRow[], withCreator: boolean): Promise<ShareLink[]> {
  const of = (kind: ShareKind) => rows.filter((row) => row.kind === kind)
  const [albumList, playlistList, trackList, creators] = await Promise.all([
    albumSummaries(of('album').map((row) => row.albumId!)),
    playlistSummaries(of('playlist').map((row) => row.playlistId!)),
    alignedTrackSummaries(viewerId, of('track').map((row) => ({ id: row.recordingId!, albumId: row.albumId }))),
    withCreator && rows.length
      ? db.select({ id: users.id, username: users.username }).from(users).where(sql`${users.id} = any(${uuidArray([...new Set(rows.map((row) => row.userId))])})`)
      : [],
  ])
  const albumsById = new Map(albumList.map((album) => [album.id, album]))
  const playlistsById = new Map(playlistList.map((playlist) => [playlist.id, playlist]))
  const tracksByShare = new Map(of('track').map((row, index) => [row.id, trackList[index] ?? null]))
  const usersById = new Map(creators.map((user) => [user.id, user]))
  return rows.map((row) => {
    const shown = row.kind === 'album'
      ? albumsById.get(row.albumId!) ?? null
      : row.kind === 'playlist' ? playlistsById.get(row.playlistId!) ?? null : tracksByShare.get(row.id) ?? null
    const title = !shown ? 'Unavailable' : 'name' in shown ? shown.name : shown.title
    const subtitle = shown && 'artistCredit' in shown ? shown.artistCredit : null
    const artwork = !shown ? null
      : 'artworks' in shown ? shown.artworks[0] ?? null
      : 'album' in shown ? shown.album?.artwork ?? null : shown.artwork
    const creator = usersById.get(row.userId)
    return {
      id: row.id,
      kind: row.kind,
      targetId: (row.kind === 'album' ? row.albumId : row.kind === 'playlist' ? row.playlistId : row.recordingId)!,
      title,
      subtitle,
      artwork,
      createdAt: row.createdAt.toISOString(),
      expiresAt: row.expiresAt?.toISOString() ?? null,
      expired: row.expiresAt !== null && row.expiresAt.getTime() <= Date.now(),
      openCount: row.openCount,
      lastOpenedAt: row.lastOpenedAt?.toISOString() ?? null,
      ...(withCreator && creator ? { createdBy: creator } : {}),
    }
  })
}
