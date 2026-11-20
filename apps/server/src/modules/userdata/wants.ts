/**
 * The wantlist: albums and tracks a user does not have yet. A want is fulfilled once
 * the album is fully owned (every track of its canonical release) or the track is
 * owned; it then stays listed with `fulfilledAt` set, and leaves the Home rail.
 */
import { queryKeys, type PageQuery, type WantEntityType, type WantItem, type WantPage } from '@squirmy/contracts'
import { and, eq, inArray, isNull, sql } from 'drizzle-orm'
import { db } from '../../database/client.js'
import { wants } from '../../database/schema.js'
import { invalidate } from '../../realtime/index.js'
import { canonicalRelease, recordingOwned } from '../catalog/availability.js'
import { after, cursorKeys, orderBy, toPage, type Ordering } from '../catalog/pagination.js'
import { resolveMerged } from '../catalog/redirects.js'
import { isoTime } from '../catalog/sql.js'
import { alignedTrackSummaries, albumSummaries } from '../catalog/summaries.js'
import { entityKey, entityTable, resolveEntity, storedType } from './entities.js'

/**
 * Marks wants fulfilled whose album is now fully owned or whose track is now owned, for
 * one user or everyone, and refreshes the affected users' wantlists. The import pipeline
 * calls this after linking files; listing wants calls it too.
 */
export async function refreshWants(userId?: string): Promise<void> {
  const rows = await db.execute<{ userId: string }>(sql`
    update wants w set fulfilled_at = now()
    where w.fulfilled_at is null and ${userId ? sql`w.user_id = ${userId}` : sql`true`}
      and case w.entity_type
        when 'recording' then ${recordingOwned('w.entity_id')}
        else exists (
          select 1 from albums a
          where a.id = w.entity_id
            and exists (select 1 from release_tracks rt where rt.release_id = ${canonicalRelease('a')})
            and not exists (
              select 1 from release_tracks rt
              where rt.release_id = ${canonicalRelease('a')} and not ${recordingOwned('rt.recording_id')}
            )
        )
      end
    returning w.user_id as "userId"`)
  for (const user of new Set(rows.map((row) => row.userId))) {
    await invalidate({ user }, [queryKeys.wants(), queryKeys.home()])
  }
}

/** Adds an album or track to the wantlist (again, if it was fulfilled before). 404 when it does not exist. */
export async function wantEntity(userId: string, type: WantEntityType, id: string): Promise<void> {
  const entityId = await resolveEntity(type, id)
  await db.insert(wants).values({ userId, entityType: storedType[type], entityId })
    .onConflictDoUpdate({ target: [wants.userId, wants.entityType, wants.entityId], set: { fulfilledAt: null, createdAt: new Date() } })
  await invalidate({ user: userId }, [queryKeys.wants(), queryKeys.home(), entityKey(type, entityId)])
  // Wanting something already owned is fulfilled at once.
  await refreshWants(userId)
}

/** Removes an album or track from the wantlist (idempotent). */
export async function unwantEntity(userId: string, type: WantEntityType, id: string): Promise<void> {
  const resolved = (await resolveMerged(entityTable[type], [id])).get(id) ?? id
  await db.delete(wants).where(and(eq(wants.userId, userId), eq(wants.entityType, storedType[type]), inArray(wants.entityId, [...new Set([id, resolved])])))
  await invalidate({ user: userId }, [queryKeys.wants(), queryKeys.home(), entityKey(type, resolved)])
}

/** Ids of the user's open album wants, newest first. */
export async function wantedAlbumIds(userId: string, limit: number): Promise<string[]> {
  const rows = await db.select({ id: wants.entityId }).from(wants)
    .where(and(eq(wants.userId, userId), eq(wants.entityType, 'album'), isNull(wants.fulfilledAt)))
    .orderBy(sql`${wants.createdAt} desc, ${wants.entityId} desc`)
    .limit(limit)
  return rows.map((row) => row.id)
}

const wantOrdering: Ordering = {
  name: 'wants',
  keys: [
    { expression: sql.raw('w.created_at'), type: 'timestamptz', descending: true },
    { expression: sql.raw('w.entity_type'), type: 'text', descending: true },
    { expression: sql.raw('w.entity_id'), type: 'uuid', descending: true },
  ],
}

/** One page of the user's wants, newest first, fulfilled ones included, after fulfilling any the library now covers. */
export async function listWants(userId: string, query: PageQuery): Promise<WantPage> {
  await refreshWants(userId)
  const rows = await db.execute<{ type: 'album' | 'recording'; id: string; wantedAt: string; fulfilledAt: string | null; cursorKeys: string[] }>(sql`
    select w.entity_type as type, w.entity_id as id, ${isoTime('w.created_at')} as "wantedAt",
      case when w.fulfilled_at is null then null else ${isoTime('w.fulfilled_at')} end as "fulfilledAt",
      ${cursorKeys(wantOrdering)}
    from wants w
    where w.user_id = ${userId} and ${after(wantOrdering, query.cursor)}
    order by ${orderBy(wantOrdering)} limit ${query.limit + 1}`)
  const page = rows.slice(0, query.limit)
  const albumIds = page.filter((row) => row.type === 'album').map((row) => row.id)
  const trackRows = page.filter((row) => row.type === 'recording')
  const [albums, tracks] = await Promise.all([
    albumSummaries(albumIds),
    alignedTrackSummaries(userId, trackRows.map((row) => ({ id: row.id }))),
  ])
  const albumById = new Map(albums.map((album) => [album.id, album]))
  const trackById = new Map(trackRows.flatMap((row, index) => tracks[index] ? [[row.id, tracks[index]] as const] : []))
  const items = page.flatMap((row): WantItem[] => {
    const base = { wantedAt: row.wantedAt, fulfilledAt: row.fulfilledAt }
    if (row.type === 'album') {
      const album = albumById.get(row.id)
      return album ? [{ type: 'album', ...base, album }] : []
    }
    const track = trackById.get(row.id)
    return track ? [{ type: 'track', ...base, track }] : []
  })
  return toPage(wantOrdering, rows, query.limit, items)
}
