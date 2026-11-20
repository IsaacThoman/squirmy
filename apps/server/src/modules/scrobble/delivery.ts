/**
 * Scrobble delivery, driven by the database. `scrobble_deliveries` holds one row per play
 * and service: `pending` until sent, `sent` once the service accepted it, `failed` after
 * repeated errors, `skipped` for plays made while the user had the service switched off.
 * The row is the idempotency record: a play gets at most one row per service (its
 * primary key), and a row is sent while it is locked, so it is submitted once even when
 * sweeps and deliveries overlap.
 */
import type { ScrobbleTarget } from '@squirmy/contracts'
import { sql } from 'drizzle-orm'
import { db } from '../../database/client.js'
import { enqueue } from '../../jobs/index.js'
import { ProviderError } from '../../lib/http.js'
import { getServerSettings } from '../../lib/settings.js'
import { lastfm } from '../metadata/index.js'
import { uuidArray } from '../catalog/sql.js'
import { type Connection, loadScrobbling, markConnection, scrobblingOf, usable, switchFor } from './connections.js'
import { describeTracks, submitPlays } from './listens.js'

export type DeliverJob = { userId: string; target: ScrobbleTarget }

/** Plays per request: ListenBrainz takes up to 1000 listens, Last.fm 50 scrobbles. */
const batchSize: Record<ScrobbleTarget, number> = { listenbrainz: 1000, lastfm: 50 }
/** Last.fm drops scrobbles older than two weeks, so older plays are not swept. */
const LOOKBACK = sql`interval '14 days'`
/** A row that failed this many times is given up on. With the backoff below that spans about a day. */
export const MAX_ATTEMPTS = 10

/** A pending row may be tried again 1, 2, 4… minutes after its last failure, at most 6 hours. */
const eligible = sql`(d.attempts = 0 or d.updated_at <= now() - least(interval '1 minute' * power(2, d.attempts - 1), interval '6 hours'))`

/** Whether the error means the user's credential is no longer valid, so retrying cannot help. */
export function rejectsCredential(target: ScrobbleTarget, error: unknown): boolean {
  if (!(error instanceof ProviderError)) return false
  return target === 'listenbrainz' ? error.upstreamStatus === 401 : error.upstreamCode === lastfm.invalidSessionCode
}

/** The service is set up on this server: Last.fm needs the operator's key and secret. */
export async function targetAvailable(target: ScrobbleTarget): Promise<boolean> {
  return target === 'listenbrainz' || (await getServerSettings()).lastFmKeySet
}

/**
 * Creates the missing delivery rows for recent completed plays of every connected user,
 * then queues `scrobble.deliver` for each user and service with rows ready to send.
 * Plays from before the connection get no row; plays while switched off get `skipped`.
 */
export async function sweepScrobbles(): Promise<void> {
  const rows = await db.execute<{ id: string; settings: Record<string, unknown> }>(sql`
    select id, settings from users
    where disabled_at is null and (settings #> '{secrets,listenbrainz}' is not null or settings #> '{secrets,lastfm}' is not null)`)
  for (const row of rows) {
    const scrobbling = scrobblingOf(row.settings)
    for (const connection of Object.values(scrobbling.connections)) {
      const { target } = connection
      const status = scrobbling.settings[switchFor[target]] ? 'pending' : 'skipped'
      await db.execute(sql`
        insert into scrobble_deliveries (play_id, target, status)
        select p.id, ${target}, ${status} from plays p
        where p.user_id = ${row.id} and p.completed and p.started_at >= ${connection.since.toISOString()}::timestamptz and p.started_at > now() - ${LOOKBACK}
          and not exists (select 1 from scrobble_deliveries d where d.play_id = p.id and d.target = ${target})
        on conflict do nothing`)
      if (!usable(scrobbling, target) || !(await targetAvailable(target))) continue
      const [ready] = await db.execute<{ ready: boolean }>(sql`
        select exists (
          select 1 from scrobble_deliveries d join plays p on p.id = d.play_id
          where p.user_id = ${row.id} and d.target = ${target} and d.status = 'pending' and ${eligible}
        ) as ready`)
      if (ready?.ready) await enqueue<DeliverJob>('scrobble.deliver', { userId: row.id, target }, { singletonKey: `${row.id}:${target}` })
    }
  }
}

/**
 * Sends the user's pending plays to one service, oldest first, in the service's batch
 * size, until none is ready. Each batch is locked while it is submitted. A failure counts
 * an attempt on the batch's rows and stops; the sweep tries again after the backoff. A
 * rejected credential marks the connection as needing attention and leaves the rows
 * pending for when the user connects again.
 */
export async function deliverScrobbles(userId: string, target: ScrobbleTarget): Promise<void> {
  for (;;) {
    const connection = usable(await loadScrobbling(userId), target)
    if (!connection || !(await targetAvailable(target))) return
    if (!(await deliverBatch(userId, connection))) return
  }
}

/** Sends one batch. Returns true when a full batch went out and more may be waiting. */
function deliverBatch(userId: string, connection: Connection): Promise<boolean> {
  const { target } = connection
  const limit = batchSize[target]
  return db.transaction(async (tx) => {
    const rows = await tx.execute<{ id: string; recordingId: string; albumId: string | null; startedAt: string }>(sql`
      select p.id, p.recording_id as "recordingId", p.album_id as "albumId", p.started_at as "startedAt"
      from scrobble_deliveries d join plays p on p.id = d.play_id
      where p.user_id = ${userId} and d.target = ${target} and d.status = 'pending' and ${eligible}
        and p.started_at >= ${connection.since.toISOString()}::timestamptz
      order by p.started_at, p.id
      limit ${limit}
      for update of d skip locked`)
    if (rows.length === 0) return false
    const ids = uuidArray(rows.map((row) => row.id))
    const tracks = await describeTracks(tx, rows)
    // Plays cascade with their recording, so every row has a track.
    const plays = rows.map((row, index) => ({ track: tracks[index]!, startedAt: new Date(row.startedAt) }))

    try {
      if (!(await submitPlays(target, connection.credential, plays))) return false
    } catch (error) {
      if (!(error instanceof ProviderError)) throw error
      if (rejectsCredential(target, error)) {
        await markConnection(connection, userId, { needsAttention: true, lastError: error.message })
        return false
      }
      await tx.execute(sql`
        update scrobble_deliveries set attempts = attempts + 1, last_error = ${error.message}, updated_at = now(),
          status = case when attempts + 1 >= ${MAX_ATTEMPTS} then 'failed' else 'pending' end
        where target = ${target} and play_id = any(${ids})`)
      await markConnection(connection, userId, { lastError: error.message })
      return false
    }
    await tx.execute(sql`
      update scrobble_deliveries set status = 'sent', attempts = attempts + 1, last_error = null, updated_at = now()
      where target = ${target} and play_id = any(${ids})`)
    if (connection.lastError) await markConnection(connection, userId, { lastError: null })
    return rows.length === limit
  })
}
