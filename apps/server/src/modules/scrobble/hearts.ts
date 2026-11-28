import { ScrobbleTarget } from '@squirmy/contracts'
import { and, eq, sql } from 'drizzle-orm'
import { db } from '../../database/client.js'
import { withSessionLock } from '../../database/locks.js'
import { likes, recordings, scrobbleHearts, users } from '../../database/schema.js'
import { enqueue } from '../../jobs/index.js'
import { ProviderError } from '../../lib/http.js'
import { creditKey } from '../../lib/text.js'
import { lastfm, listenbrainz } from '../metadata/index.js'
import type { RemoteFeedback } from '../metadata/feedback.js'
import { announceUserChange } from '../userdata/changes.js'
import { type Connection, loadScrobbling, markConnection, usable } from './connections.js'
import { rejectsCredential, targetAvailable } from './delivery.js'

const syncSwitch = { listenbrainz: 'syncListenBrainzHearts', lastfm: 'syncLastFmHearts' } as const
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i

export async function sweepHearts(): Promise<void> {
  const rows = await db.execute<{ id: string }>(sql`
    select id from users where disabled_at is null
    and (settings->'syncListenBrainzHearts' = 'true'::jsonb or settings->'syncLastFmHearts' = 'true'::jsonb)`)
  for (const { id } of rows) await enqueue('scrobble.hearts', { userId: id }, { singletonKey: id })
}

async function match({ mbid, artist, title }: RemoteFeedback): Promise<string | undefined> {
  if (mbid && uuid.test(mbid)) {
    const [row] = await db.select({ id: recordings.id }).from(recordings).where(eq(recordings.mbid, mbid))
    if (row) return row.id
  }
  if (!artist || !title) return undefined
  const rows = await db.select({ id: recordings.id }).from(recordings).where(eq(recordings.matchKey, creditKey(artist, title))).limit(2)
  return rows.length === 1 ? rows[0]?.id : undefined
}

async function applyFeedback(userId: string, connection: string, items: RemoteFeedback[]) {
  for (const item of items) {
    if (!Number.isFinite(item.at) || item.at <= 0 || item.at > 8.64e12) continue
    const recordingId = await match(item)
    if (!recordingId) continue
    const remoteAt = new Date(item.at * 1000)
    const key = { userId, connection, recordingId }
    const changed = await db.transaction(async tx => {
      const where = and(eq(scrobbleHearts.userId, userId), eq(scrobbleHearts.connection, connection), eq(scrobbleHearts.recordingId, recordingId))
      const [state] = await tx.select().from(scrobbleHearts).where(where)
      if (state?.remoteAt && state.remoteAt >= remoteAt) return false
      await tx.insert(scrobbleHearts).values({ ...key, remoteAt })
        .onConflictDoUpdate({ target: [scrobbleHearts.userId, scrobbleHearts.connection, scrobbleHearts.recordingId], set: { remoteAt } })
      // Acknowledgements may return through the read API after a local unheart.
      if (item.loved && state?.exportedAt && remoteAt <= state.exportedAt) return false
      const heart = and(eq(likes.userId, userId), eq(likes.entityType, 'recording'), eq(likes.entityId, recordingId))
      if (!item.loved) {
        const deleted = await tx.delete(likes).where(and(heart, sql`date_trunc('second', ${likes.createdAt}) <= ${remoteAt.toISOString()}::timestamptz`)).returning({ id: likes.entityId })
        return deleted.length > 0
      }
      const inserted = await tx.insert(likes).values({ userId, entityType: 'recording', entityId: recordingId, importedHeart: true, createdAt: remoteAt })
        .onConflictDoNothing().returning({ id: likes.entityId })
      const [saved] = await tx.select({ at: likes.createdAt }).from(likes).where(heart)
      if (saved && saved.at.getTime() <= remoteAt.getTime() + 999) {
        await tx.update(scrobbleHearts).set({ exportedHeartAt: saved.at }).where(where)
      }
      return inserted.length > 0
    })
    if (changed) await announceUserChange(userId, 'track', recordingId)
  }
}

async function importFeedback(userId: string, connection: Connection, key: string) {
  for (let page = 1; page <= 100; page++) {
    const result = connection.target === 'lastfm'
      ? await lastfm.lovedPage(connection.account, page)
      : await listenbrainz.feedbackPage(connection.credential, connection.account, (page - 1) * 100, connection.apiUrl)
    await applyFeedback(userId, key, result.items)
    if (!result.more) return
  }
}

async function exportFeedback(userId: string, connection: Connection, key: string) {
  const rows = await db.execute<{ id: string; title: string; artist: string; mbid: string | null; createdAt: string }>(sql`
    select r.id, r.title, r.artist_credit as artist, r.mbid, l.created_at as "createdAt"
    from likes l join recordings r on r.id = l.entity_id
    left join scrobble_hearts h on h.user_id = l.user_id and h.connection = ${key} and h.recording_id = r.id
    where l.user_id = ${userId} and l.entity_type = 'recording' and not l.imported_heart
    and h.exported_heart_at is distinct from l.created_at
    and (${connection.target} <> 'listenbrainz' or r.mbid is not null)
    order by l.created_at, r.id limit 50`)
  for (const row of rows) {
    if (connection.target === 'listenbrainz') await listenbrainz.love(connection.credential, row.mbid!, connection.apiUrl)
    else if (!(await lastfm.love(connection.credential, row.artist, row.title))) return
    const update = { exportedHeartAt: new Date(row.createdAt), exportedAt: new Date() }
    await db.insert(scrobbleHearts).values({ userId, connection: key, recordingId: row.id, ...update })
      .onConflictDoUpdate({ target: [scrobbleHearts.userId, scrobbleHearts.connection, scrobbleHearts.recordingId], set: update })
  }
}

export async function syncHearts(userId: string): Promise<void> {
  await withSessionLock(`scrobble.hearts:${userId}`, async () => {
    const [user] = await db.select({ disabledAt: users.disabledAt }).from(users).where(eq(users.id, userId))
    if (!user || user.disabledAt) return
    const state = await loadScrobbling(userId)
    for (const target of ScrobbleTarget.options) {
      const connection = usable(state, target)
      if (!connection || !state.settings[syncSwitch[target]] || !(await targetAvailable(target))) continue
      const key = JSON.stringify([target, connection.apiUrl, connection.account])
      try {
        await importFeedback(userId, connection, key)
        await exportFeedback(userId, connection, key)
      } catch (error) {
        if (!(error instanceof ProviderError)) throw error
        await markConnection(connection, userId, { lastError: error.message, ...(rejectsCredential(target, error) ? { needsAttention: true } : {}) })
      }
    }
  })
}
