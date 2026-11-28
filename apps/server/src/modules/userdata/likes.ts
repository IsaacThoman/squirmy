/**
 * Saves (the heart; stars in Subsonic, loves on Last.fm) and ratings. Both point at catalog
 * rows, never files, and take API entity types (`track`, `album`, `artist`). A save is what
 * puts something in a user's library, beside the server's collection.
 */
import {
  LIKED_SONGS_ID, queryKeys, type AlbumPage, type AlbumSummary, type ArtistPage, type ArtistSummary, type LikeEntityType, type Page, type PageQuery, type TrackPage, type TrackSummary,
} from '@squirmy/contracts'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { db } from '../../database/client.js'
import { likes, ratings } from '../../database/schema.js'
import { badRequest } from '../../lib/errors.js'
import { after, cursorKeys, orderBy, toPage, type Ordering } from '../catalog/pagination.js'
import { resolveMerged } from '../catalog/redirects.js'
import { albumSummaries, artistSummaries, trackSummaries } from '../catalog/summaries.js'
import { recordCollectionAdd } from '../sessions/collection-plays.js'
import { announceUserChange } from './changes.js'
import { entityTable, resolveEntity, storedType } from './entities.js'
import { fetchMissingOf } from './library.js'
import { smartPlaylistInvalidations } from './smart-refresh.js'
import { invalidate, publishChanges } from '../../realtime/index.js'

/**
 * Saves an entity with the heart (idempotent): the one way into a user's library. Follows
 * merge redirects; 404 when it does not exist. For a user who may fetch music, an album or
 * track is then fetched in the background (`fetchMissingOf`). Returns the id saved.
 *
 * `savedAt` puts the save back at the time a removal answered (Undo), so the item returns to
 * its place in Recently added and Liked Songs; a time in the future is taken as now. An
 * existing save keeps its own time.
 *
 * A new save (not an Undo) also puts what it added at the top of the Library's Recently
 * played: the album or artist, or Liked Songs for a track.
 */
export async function likeEntity(userId: string, type: LikeEntityType, id: string, options: { savedAt?: string } = {}): Promise<string> {
  const entityId = await resolveEntity(type, id)
  const now = new Date()
  const savedAt = options.savedAt ? new Date(Math.min(new Date(options.savedAt).getTime(), now.getTime())) : now
  const inserted = await db.insert(likes).values({ userId, entityType: storedType[type], entityId, createdAt: savedAt })
    .onConflictDoNothing().returning({ id: likes.entityId })
  if (inserted.length > 0 && !options.savedAt) {
    await recordCollectionAdd(userId, type === 'track' ? { type: 'liked', id: LIKED_SONGS_ID } : { type, id: entityId })
  }
  await announceUserChange(userId, type, entityId)
  if (type !== 'artist') await fetchMissingOf(userId, type, entityId)
  return entityId
}

/**
 * Removes a save (idempotent), under the given id and wherever its redirects lead. Nothing
 * else goes: files stay as cache, playlists and history stay. Returns when the save was made
 * (the earliest, should both ids have had one), for Undo; null when there was none.
 */
export async function unlikeEntity(userId: string, type: LikeEntityType, id: string): Promise<Date | null> {
  const resolved = (await resolveMerged(entityTable[type], [id])).get(id)
  const ids = [...new Set([id, resolved ?? id])]
  const removed = await db.delete(likes)
    .where(and(eq(likes.userId, userId), eq(likes.entityType, storedType[type]), inArray(likes.entityId, ids)))
    .returning({ createdAt: likes.createdAt })
  await announceUserChange(userId, type, resolved ?? id)
  const times = removed.map((row) => row.createdAt.getTime())
  return times.length > 0 ? new Date(Math.min(...times)) : null
}

const likeOrdering = (type: LikeEntityType): Ordering => ({
  name: `likes:${type}`,
  keys: [
    { expression: sql.raw('l.created_at'), type: 'timestamptz', descending: true },
    { expression: sql.raw('l.entity_id'), type: 'uuid', descending: true },
  ],
})

/** One page of the user's saves of one type, newest first (Liked Songs for tracks). */
export async function listLikes(userId: string, type: 'track', query: PageQuery): Promise<TrackPage>
export async function listLikes(userId: string, type: 'album', query: PageQuery): Promise<AlbumPage>
export async function listLikes(userId: string, type: 'artist', query: PageQuery): Promise<ArtistPage>
export async function listLikes(userId: string, type: LikeEntityType, query: PageQuery): Promise<Page<TrackSummary | AlbumSummary | ArtistSummary>>
export async function listLikes(userId: string, type: LikeEntityType, query: PageQuery): Promise<Page<TrackSummary | AlbumSummary | ArtistSummary>> {
  const ordering = likeOrdering(type)
  const rows = await db.execute<{ id: string; cursorKeys: string[] }>(sql`
    select l.entity_id as id, ${cursorKeys(ordering)} from likes l
    where l.user_id = ${userId} and l.entity_type = ${storedType[type]} and ${after(ordering, query.cursor)}
    order by ${orderBy(ordering)} limit ${query.limit + 1}`)
  const ids = rows.slice(0, query.limit).map((row) => row.id)
  const items: (TrackSummary | AlbumSummary | ArtistSummary)[] = type === 'track'
    ? await trackSummaries(userId, ids.map((id) => ({ id })))
    : type === 'album' ? await albumSummaries(ids) : await artistSummaries(ids, userId)
  return toPage(ordering, rows, query.limit, items)
}

/**
 * Sets a 1–5 star rating; 0 removes it. Follows merge redirects; 404 when the entity
 * does not exist. The user's devices get a track's new `rating` as a `patch`, and their smart
 * playlists (which may sort or filter by rating) are refreshed.
 */
export async function setRating(userId: string, type: LikeEntityType, id: string, rating: number): Promise<void> {
  if (!Number.isInteger(rating) || rating < 0 || rating > 5) throw badRequest('A rating is 0 to 5 stars', 'invalid_rating')
  const entityId = await resolveEntity(type, id)
  const where = and(eq(ratings.userId, userId), eq(ratings.entityType, storedType[type]), eq(ratings.entityId, entityId))
  if (rating === 0) await db.delete(ratings).where(where)
  else {
    await db.insert(ratings).values({ userId, entityType: storedType[type], entityId, rating })
      .onConflictDoUpdate({ target: [ratings.userId, ratings.entityType, ratings.entityId], set: { rating, updatedAt: new Date() } })
  }
  if (type === 'track') await publishChanges({ user: userId }, [{ kind: 'patch', entity: 'track', id: entityId, fields: { rating: rating || null } }])
  for (const [target, keys] of await smartPlaylistInvalidations([{ user: userId }], [queryKeys.likes()])) await invalidate(target, keys)
}
