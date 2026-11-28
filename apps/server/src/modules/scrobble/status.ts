import { queryKeys, ScrobbleTarget, type ScrobblingStatus } from '@squirmy/contracts'
import { sql } from 'drizzle-orm'
import { db } from '../../database/client.js'
import { getServerSettings } from '../../lib/settings.js'
import { invalidate } from '../../realtime/index.js'
import { loadScrobbling, switchFor } from './connections.js'

/** Every service as the user sees it: availability, account, switch, health and backlog. */
export async function scrobblingStatus(userId: string): Promise<ScrobblingStatus> {
  const [scrobbling, server, counts] = await Promise.all([
    loadScrobbling(userId),
    getServerSettings(),
    // Pending and failed rows are few, so the status index finds them before the join.
    db.execute<{ target: ScrobbleTarget; pending: number; failed: number }>(sql`
      select d.target, count(*) filter (where d.status = 'pending')::int as pending, count(*) filter (where d.status = 'failed')::int as failed
      from scrobble_deliveries d join plays p on p.id = d.play_id
      where d.status in ('pending', 'failed') and p.user_id = ${userId}
      group by d.target`),
  ])
  return {
    services: ScrobbleTarget.options.map((target) => {
      const connection = scrobbling.connections[target]
      const count = counts.find((row) => row.target === target)
      return {
        target,
        available: target === 'listenbrainz' || server.lastFmKeySet,
        connected: Boolean(connection),
        account: connection?.account ?? null,
        apiUrl: connection?.apiUrl,
        enabled: scrobbling.settings[switchFor[target]],
        needsAttention: connection?.needsAttention ?? false,
        lastError: connection?.lastError ?? null,
        connectedAt: connection?.since.toISOString() ?? null,
        pending: count?.pending ?? 0,
        failed: count?.failed ?? 0,
      }
    }),
  }
}

/** Refreshes the user's scrobbling screen and settings after a connection changed. */
export async function invalidateScrobbling(userId: string): Promise<void> {
  await invalidate({ user: userId }, [queryKeys.scrobbling(), queryKeys.settings()])
}
