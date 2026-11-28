/**
 * Whether a provider is delivering. A provider whose sign-in to its source ran out fails
 * every fetch the same way; taken one by one, each failure would gray its track out for a
 * day (a miss) and the outage would only show as music going missing.
 *
 * So failures the provider is answerable for (it could not be reached, refused a call, or
 * reported the job failed) are counted per provider, by recording, until it next delivers.
 * Once `FAILING_AFTER` different recordings have failed, the provider is failing: the misses
 * that streak left are dropped (the tracks were not the problem, so the sessions that
 * skipped them as not available are told they are playable again), later failures record
 * none, the admin page says since when it has failed and why, and the sessions waiting on
 * its fetches pause with a reason (`OUTAGE_REASON`) instead of skipping down the queue.
 * Fetches still go to it: the first one it delivers ends the outage.
 */
import { sql } from 'drizzle-orm'
import { db, type Transaction } from '../../database/client.js'
import { uuidArray } from '../catalog/sql.js'
import { announceOutcome } from './outcomes.js'
import { isFailing } from './providers.js'
import { announceAvailability } from './resolve.js'

/** Recordings remembered per streak: enough to count and to clear their misses. */
const REMEMBERED = 50
/** What a listener is told when playback pauses because the provider is failing. */
export const OUTAGE_REASON = 'The server can’t fetch music on demand right now.'

/**
 * Records a failure the provider is answerable for, for these recordings, with the message
 * kept as its `last_error`. Returns whether the provider is failing now. When it is, misses
 * recorded for the streak's recordings since it began are dropped and their tracks refreshed.
 */
export async function noteProviderFailure(providerId: string, message: string, recordingIds: readonly string[] = []): Promise<boolean> {
  const { outage, restored } = await db.transaction((tx) => recordProviderFailure(tx, providerId, message, recordingIds))
  await announceAvailability(restored)
  return outage
}

/** Keep the streak and the misses it clears in the same transaction as a job's failure. */
export async function recordProviderFailure(tx: Transaction, providerId: string, message: string, recordingIds: readonly string[]) {
  const rows = await tx.execute<{ failingSince: Date | string; failing: string[] }>(sql`
    update acquisition_providers set
      last_error = ${message.slice(0, 500)},
      failing_since = coalesce(failing_since, now()),
      failing_recordings = coalesce((
        select (array_agg(id order by first))[1:${sql.raw(String(REMEMBERED))}]
        from (select id, min(n) as first from unnest(failing_recordings || ${uuidArray(recordingIds)}) with ordinality as t(id, n) group by id) ids
      ), '{}'::uuid[]),
      updated_at = now()
    where id = ${providerId}
    returning failing_since as "failingSince", failing_recordings as failing`)
  const row = rows[0]
  if (!row) return { outage: false, restored: [] }
  const since = new Date(row.failingSince)
  if (!isFailing({ failingSince: since, failingRecordings: row.failing })) return { outage: false, restored: [] }
  const cleared = await tx.execute<{ id: string }>(sql`
    delete from acquisition_misses
    where provider_id = ${providerId} and entity_type = 'recording'
      and entity_id = any(${uuidArray(row.failing)}) and created_at >= ${since.toISOString()}
    returning entity_id as id`)
  const ids = cleared.map((miss) => miss.id)
  // Sessions skipped those tracks as not available: they are playable after all.
  await announceOutcome({ restored: ids }, tx)
  return { outage: true, restored: ids }
}

/** The provider delivered: whatever streak of failures it had is over. */
export async function noteProviderDelivered(providerId: string) {
  await db.execute(sql`
    update acquisition_providers set failing_since = null, failing_recordings = '{}'::uuid[], last_error = null, last_ok_at = now(), updated_at = now()
    where id = ${providerId}`)
}
