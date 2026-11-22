/**
 * Misses: what a provider could not supply (an empty resolve, a refusal, a failed or
 * mismatched delivery). A miss grays a recording out for that provider for a day.
 *
 * A miss says something about the provider as it was when it answered, not about the track
 * for ever. A provider with a bug can miss hundreds of tracks it would supply once fixed,
 * so each miss is recorded at the provider's `miss_epoch` (and with its `identity`, for the
 * history), and only misses at the current epoch count. The epoch moves on when the
 * provider changes (another version or capabilities, re-enabled, a new address or secret)
 * and when an admin retries its unavailable tracks. Older rows stay until they expire.
 */
import { and, eq, inArray, lt, sql } from 'drizzle-orm'
import { db } from '../../database/client.js'
import { acquisitionMisses, acquisitionOffers } from '../../database/schema.js'
import { uuidArray } from '../catalog/sql.js'

/** A miss keeps a recording gray for this long. */
export const MISS_TTL_MS = 24 * 60 * 60_000

type Executor = Pick<typeof db, 'execute' | 'insert' | 'delete'>

const cutoff = (now = Date.now()) => new Date(now - MISS_TTL_MS).toISOString()

/** Misses of these recordings that count: younger than a day, at their provider's current epoch. */
export async function currentMisses(recordingIds: readonly string[]): Promise<{ providerId: string; id: string }[]> {
  if (recordingIds.length === 0) return []
  return db.execute<{ providerId: string; id: string }>(sql`
    select m.provider_id as "providerId", m.entity_id as id
    from acquisition_misses m join acquisition_providers p on p.id = m.provider_id and p.miss_epoch = m.provider_epoch
    where m.entity_type = 'recording' and m.entity_id = any(${uuidArray(recordingIds)}) and m.created_at > ${cutoff()}`)
}

/** How many recordings each provider has a miss for that counts. Providers without any are left out. */
export async function unavailableCounts(): Promise<Map<string, number>> {
  const rows = await db.execute<{ providerId: string; count: number }>(sql`
    select m.provider_id as "providerId", count(*)::int as count
    from acquisition_misses m join acquisition_providers p on p.id = m.provider_id and p.miss_epoch = m.provider_epoch
    where m.entity_type = 'recording' and m.created_at > ${cutoff()}
    group by m.provider_id`)
  return new Map(rows.map((row) => [row.providerId, row.count]))
}

/**
 * Remembers that a provider cannot supply these, so they turn gray for a day, and drops
 * any cached offers for them. The miss is recorded at the provider's epoch as it is now.
 */
export async function recordMisses(executor: Pick<typeof db, 'insert' | 'delete'>, providerId: string, entityType: 'recording' | 'album', ids: readonly string[], reason: string) {
  if (ids.length === 0) return
  const providerEpoch = sql<number>`coalesce((select miss_epoch from acquisition_providers where id = ${providerId}), 0)`
  const providerIdentity = sql<string | null>`(select identity from acquisition_providers where id = ${providerId})`
  await executor.insert(acquisitionMisses).values(ids.map((entityId) => ({
    providerId, entityType, entityId, reason: reason.slice(0, 500), providerEpoch, providerIdentity, createdAt: new Date(),
  }))).onConflictDoUpdate({
    target: [acquisitionMisses.providerId, acquisitionMisses.entityType, acquisitionMisses.entityId],
    set: {
      reason: sql`excluded.reason`, createdAt: sql`excluded.created_at`,
      providerEpoch: sql`excluded.provider_epoch`, providerIdentity: sql`excluded.provider_identity`,
    },
  })
  if (entityType === 'recording') {
    await executor.delete(acquisitionOffers).where(and(eq(acquisitionOffers.providerId, providerId), inArray(acquisitionOffers.recordingId, [...ids])))
  }
}

/**
 * Stops counting every miss a provider has recorded so far, by moving its epoch on; the
 * rows stay for the history. With `resetHealth` its failing streak (health.ts) ends too:
 * those failures were the provider as it was before. Returns the recordings that were
 * unavailable from it, so their screens can be refreshed.
 */
export async function forgetMisses(executor: Executor, providerId: string, options: { resetHealth?: boolean } = {}): Promise<string[]> {
  const health = options.resetHealth ? sql`, failing_since = null, failing_recordings = '{}'::uuid[]` : sql``
  const rows = await executor.execute<{ id: string }>(sql`
    with current_misses as (
      select m.entity_id as id
      from acquisition_misses m join acquisition_providers p on p.id = m.provider_id and p.miss_epoch = m.provider_epoch
      where m.provider_id = ${providerId} and m.entity_type = 'recording' and m.created_at > ${cutoff()}
    ), bumped as (
      update acquisition_providers set miss_epoch = miss_epoch + 1, updated_at = now()${health} where id = ${providerId} returning id
    )
    select id from current_misses where exists (select 1 from bumped)`)
  return rows.map((row) => row.id)
}

/** Deletes misses too old to count. */
export async function expireMisses(now = Date.now()) {
  await db.delete(acquisitionMisses).where(lt(acquisitionMisses.createdAt, new Date(now - MISS_TTL_MS)))
}
