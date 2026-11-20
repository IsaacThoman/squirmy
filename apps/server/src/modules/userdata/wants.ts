/**
 * The wantlist: albums and tracks a user does not have yet. A want is fulfilled once
 * the album is fully owned (every track of its canonical release) or the track is
 * owned; fulfilled wants leave the list.
 */
import { queryKeys, type WantEntityType, type WantsResponse } from '@squirmy/contracts'
import { and, eq, inArray, isNull, sql } from 'drizzle-orm'
import { db } from '../../database/client.js'
import { wants } from '../../database/schema.js'
import { invalidate } from '../../realtime/index.js'
import { canonicalRelease, recordingOwned } from '../catalog/availability.js'
import { resolveMerged } from '../catalog/redirects.js'
import { albumSummaries, trackSummaries } from '../catalog/summaries.js'
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

/** Ids of the user's open wants of one type, newest first. */
export async function wantedIds(userId: string, type: WantEntityType, limit?: number): Promise<string[]> {
  const query = db.select({ id: wants.entityId }).from(wants)
    .where(and(eq(wants.userId, userId), eq(wants.entityType, storedType[type]), isNull(wants.fulfilledAt)))
    .orderBy(sql`${wants.createdAt} desc, ${wants.entityId} desc`)
  return (await (limit ? query.limit(limit) : query)).map((row) => row.id)
}

/** The user's open wants, newest first, after fulfilling any the library now covers. */
export async function listWants(userId: string): Promise<WantsResponse> {
  await refreshWants(userId)
  const [albumIds, trackIds] = await Promise.all([wantedIds(userId, 'album'), wantedIds(userId, 'track')])
  const [albums, tracks] = await Promise.all([albumSummaries(albumIds), trackSummaries(userId, trackIds.map((id) => ({ id })))])
  return { albums, tracks }
}
