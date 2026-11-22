/**
 * Saves (the heart; stars in Subsonic, loves on Last.fm) and ratings. Both point at catalog
 * rows, never files, and take API entity types (`track`, `album`, `artist`). A save is what
 * puts something in a user's library, beside the server's collection.
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
import { fetchMissingOf } from './library.js'

/**
 * Everything that shows the heart or library membership the save changes, for the user's
 * other devices. Library lists and Home move for every type; a track's heart also shows on
 * its album and artist pages and in the playlists that hold it; an album's save puts its
 * tracks (wherever they are listed) and its artists in the library.
 */
async function invalidateSave(userId: string, type: LikeEntityType, id: string) {
  const keys: (readonly unknown[])[] = [queryKeys.likes(), queryKeys.home(), queryKeys.library(), queryKeys.search(), entityKey(type, id)]
  if (type === 'track') {
    const pages = await db.execute<{ kind: 'album' | 'artist'; id: string }>(sql`
      select distinct 'album' as kind, rl.album_id as id from release_tracks rt join releases rl on rl.id = rt.release_id where rt.recording_id = ${id}
      union
      -- Album pages also list owned recordings filed under them that the release does not.
      select 'album', album_id from media_files where recording_id = ${id} and album_id is not null
      union
      select 'artist', artist_id from recording_artists where recording_id = ${id}`)
    // Only the playlists the user can open that hold the track: the playlists list shows
    // no hearts, and refreshing it on every save refetched it for nothing.
    const holding = await db.execute<{ id: string }>(sql`
      select distinct p.id from playlist_items i join playlists p on p.id = i.playlist_id
      where i.recording_id = ${id} and (p.owner_id = ${userId} or p.is_public)`)
    keys.push(queryKeys.history(), queryKeys.wants(),
      ...holding.map((playlist) => queryKeys.playlist(playlist.id)), ...pages.map((page) => entityKey(page.kind, page.id)))
  } else if (type === 'album') {
    // Every row of the album's tracks carries `inLibrary`, wherever it is listed.
    const pages = await db.execute<{ kind: 'artist' | 'track'; id: string }>(sql`
      select 'artist' as kind, artist_id as id from album_artists where album_id = ${id}
      union select 'track', recording_id from media_files where album_id = ${id} and recording_id is not null
      union select 'track', rt.recording_id from release_tracks rt join releases rl on rl.id = rt.release_id where rl.album_id = ${id}`)
    keys.push(queryKeys.playlists(), queryKeys.history(), queryKeys.wants(), ...pages.map((page) => entityKey(page.kind, page.id)))
  }
  await invalidate({ user: userId }, keys)
}

/**
 * Saves an entity with the heart (idempotent): the one way into a user's library. Follows
 * merge redirects; 404 when it does not exist. For a user who may fetch music, an album or
 * track is then fetched in the background (`fetchMissingOf`). Returns the id saved.
 */
export async function likeEntity(userId: string, type: LikeEntityType, id: string): Promise<string> {
  const entityId = await resolveEntity(type, id)
  await db.insert(likes).values({ userId, entityType: storedType[type], entityId }).onConflictDoNothing()
  await invalidateSave(userId, type, entityId)
  if (type !== 'artist') await fetchMissingOf(userId, type, entityId)
  return entityId
}

/**
 * Removes a save (idempotent), under the given id and wherever its redirects lead. Nothing
 * else goes: files stay as cache, playlists and history stay.
 */
export async function unlikeEntity(userId: string, type: LikeEntityType, id: string): Promise<void> {
  const resolved = (await resolveMerged(entityTable[type], [id])).get(id)
  const ids = [...new Set([id, resolved ?? id])]
  await db.delete(likes).where(and(eq(likes.userId, userId), eq(likes.entityType, storedType[type]), inArray(likes.entityId, ids)))
  await invalidateSave(userId, type, resolved ?? id)
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
