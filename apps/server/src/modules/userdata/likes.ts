/**
 * Likes (stars in Subsonic) and ratings. Both point at catalog rows, never files, and
 * take API entity types (`track`, `album`, `artist`).
 */
import {
  queryKeys,
  type AlbumPage, type AlbumSummary, type ArtistPage, type ArtistSummary, type LikeEntityType, type Page, type PageQuery, type TrackPage, type TrackSummary,
} from '@squirmy/contracts'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { db } from '../../database/client.js'
import { likes, ratings } from '../../database/schema.js'
import { badRequest } from '../../lib/errors.js'
import { invalidate } from '../../realtime/index.js'
import { after, cursorKeys, orderBy, toPage, type Ordering } from '../catalog/pagination.js'
import { resolveMerged } from '../catalog/redirects.js'
import { albumSummaries, artistSummaries, trackSummaries } from '../catalog/summaries.js'
import { entityKey, entityTable, resolveEntity, storedType } from './entities.js'

/** Everything that shows a like flag for the entity, for the user's other devices. */
async function invalidateLike(userId: string, type: LikeEntityType, id: string) {
  const keys: (readonly unknown[])[] = [queryKeys.likes(), queryKeys.home(), entityKey(type, id)]
  if (type === 'track') {
    // Track hearts also show on album and artist pages, playlists, history, songs lists and search results.
    const pages = await db.execute<{ kind: 'album' | 'artist'; id: string }>(sql`
      select distinct 'album' as kind, rl.album_id as id from release_tracks rt join releases rl on rl.id = rt.release_id where rt.recording_id = ${id}
      union
      select 'artist', artist_id from recording_artists where recording_id = ${id}`)
    keys.push(queryKeys.playlists(), queryKeys.history(), queryKeys.libraryTracks(), queryKeys.search(), ...pages.map((page) => entityKey(page.kind, page.id)))
  }
  await invalidate({ user: userId }, keys)
}

/** Likes an entity (idempotent). Follows merge redirects; 404 when it does not exist. Returns the id liked. */
export async function likeEntity(userId: string, type: LikeEntityType, id: string): Promise<string> {
  const entityId = await resolveEntity(type, id)
  await db.insert(likes).values({ userId, entityType: storedType[type], entityId }).onConflictDoNothing()
  await invalidateLike(userId, type, entityId)
  return entityId
}

/** Removes a like (idempotent), under the given id and wherever its redirects lead. */
export async function unlikeEntity(userId: string, type: LikeEntityType, id: string): Promise<void> {
  const resolved = (await resolveMerged(entityTable[type], [id])).get(id)
  const ids = [...new Set([id, resolved ?? id])]
  await db.delete(likes).where(and(eq(likes.userId, userId), eq(likes.entityType, storedType[type]), inArray(likes.entityId, ids)))
  await invalidateLike(userId, type, resolved ?? id)
}

const likeOrdering = (type: LikeEntityType): Ordering => ({
  name: `likes:${type}`,
  keys: [
    { expression: sql.raw('l.created_at'), type: 'timestamptz', descending: true },
    { expression: sql.raw('l.entity_id'), type: 'uuid', descending: true },
  ],
})

/** One page of the user's likes of one type, newest first. */
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
    : type === 'album' ? await albumSummaries(ids) : await artistSummaries(ids)
  return toPage(ordering, rows, query.limit, items)
}

/**
 * Sets a 1–5 star rating; 0 removes it. Follows merge redirects; 404 when the entity
 * does not exist. Ratings have no native screen, so nothing is invalidated.
 */
export async function setRating(userId: string, type: LikeEntityType, id: string, rating: number): Promise<void> {
  if (!Number.isInteger(rating) || rating < 0 || rating > 5) throw badRequest('A rating is 0 to 5 stars', 'invalid_rating')
  const entityId = await resolveEntity(type, id)
  const where = and(eq(ratings.userId, userId), eq(ratings.entityType, storedType[type]), eq(ratings.entityId, entityId))
  if (rating === 0) {
    await db.delete(ratings).where(where)
    return
  }
  await db.insert(ratings).values({ userId, entityType: storedType[type], entityId, rating })
    .onConflictDoUpdate({ target: [ratings.userId, ratings.entityType, ratings.entityId], set: { rating, updatedAt: new Date() } })
}

/** The user's ratings of the given entities, keyed by id; unrated ids are absent. Ids are not redirect-resolved. */
export async function getRatings(userId: string, type: LikeEntityType, ids: readonly string[]): Promise<Map<string, number>> {
  if (ids.length === 0) return new Map()
  const rows = await db.select({ id: ratings.entityId, rating: ratings.rating }).from(ratings)
    .where(and(eq(ratings.userId, userId), eq(ratings.entityType, storedType[type]), inArray(ratings.entityId, [...ids])))
  return new Map(rows.map((row) => [row.id, row.rating]))
}
