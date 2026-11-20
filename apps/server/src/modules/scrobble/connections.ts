/**
 * A user's scrobbling accounts. Each lives on the user row under
 * `settings.secrets.<target>`; only the credential (ListenBrainz token, Last.fm session
 * key) is secret, and it is stored encrypted.
 */
import { ScrobbleTarget, UserSettings } from '@squirmy/contracts'
import { eq, sql } from 'drizzle-orm'
import { db, type Executor } from '../../database/client.js'
import { users } from '../../database/schema.js'
import { decrypt, encrypt } from '../../lib/crypto.js'
import { notFound } from '../../lib/errors.js'

type StoredConnection = {
  /** `encrypt('scrobble-credential', …)` of the token or session key. */
  credential: string
  account: string
  /** ISO time of the first connection to this account. Earlier plays are never scrobbled. */
  since: string
  needsAttention?: boolean
  lastError?: string | null
}

export type Connection = {
  target: ScrobbleTarget
  credential: string
  /** The stored ciphertext, which identifies this connection when it is updated later. */
  ciphertext: string
  account: string
  since: Date
  needsAttention: boolean
  lastError: string | null
}

export type UserScrobbling = { settings: UserSettings; connections: Partial<Record<ScrobbleTarget, Connection>> }

const purpose = 'scrobble-credential'

/** The `UserSettings` switch that turns each service on and off. */
export const switchFor = { listenbrainz: 'scrobbleListenBrainz', lastfm: 'scrobbleLastFm' } as const satisfies Record<ScrobbleTarget, keyof UserSettings>

function storedConnections(settings: Record<string, unknown>): Partial<Record<ScrobbleTarget, StoredConnection>> {
  return (settings.secrets as Partial<Record<ScrobbleTarget, StoredConnection>> | undefined) ?? {}
}

/** Reads the user's settings and connections from a `users.settings` value. */
export function scrobblingOf(settings: Record<string, unknown>): UserScrobbling {
  const stored = storedConnections(settings)
  const connections: UserScrobbling['connections'] = {}
  for (const target of ScrobbleTarget.options) {
    const one = stored[target]
    if (!one) continue
    connections[target] = {
      target,
      credential: decrypt(purpose, one.credential),
      ciphertext: one.credential,
      account: one.account,
      since: new Date(one.since),
      needsAttention: one.needsAttention ?? false,
      lastError: one.lastError ?? null,
    }
  }
  return { settings: UserSettings.parse(settings), connections }
}

/** The user's settings and scrobbling connections. */
export async function loadScrobbling(userId: string): Promise<UserScrobbling> {
  const [row] = await db.select({ settings: users.settings }).from(users).where(eq(users.id, userId))
  if (!row) throw notFound('No such user')
  return scrobblingOf(row.settings)
}

/** A connection that deliveries and now-playing may use: switched on and not rejected. */
export function usable(scrobbling: UserScrobbling, target: ScrobbleTarget): Connection | null {
  const connection = scrobbling.connections[target]
  return connection && !connection.needsAttention && scrobbling.settings[switchFor[target]] ? connection : null
}

/** Removes the user's deliveries that were never sent, so a different account does not receive them. */
async function dropPending(executor: Executor, userId: string, target: ScrobbleTarget) {
  await executor.execute(sql`
    delete from scrobble_deliveries d using plays p
    where p.id = d.play_id and p.user_id = ${userId} and d.target = ${target} and d.status = 'pending'`)
}

/**
 * Stores a verified credential and switches the service on. Connecting the same account
 * again (a new token, or after the old one was revoked) keeps its start time, so plays
 * waiting for it are still sent; a different account starts from now.
 */
export async function saveConnection(userId: string, target: ScrobbleTarget, credential: string, account: string): Promise<void> {
  await db.transaction(async (tx) => {
    const [row] = await tx.select({ settings: users.settings }).from(users).where(eq(users.id, userId)).for('update')
    if (!row) throw notFound('No such user')
    const previous = storedConnections(row.settings)[target]
    const sameAccount = previous?.account === account
    if (previous && !sameAccount) await dropPending(tx, userId, target)
    const stored: StoredConnection = { credential: encrypt(purpose, credential), account, since: sameAccount ? previous.since : new Date().toISOString() }
    await tx.update(users).set({
      settings: sql`${users.settings}
        || jsonb_build_object('secrets', coalesce(${users.settings}->'secrets', '{}'::jsonb) || jsonb_build_object(${target}::text, ${JSON.stringify(stored)}::jsonb))
        || jsonb_build_object(${switchFor[target]}::text, true)`,
      updatedAt: new Date(),
    }).where(eq(users.id, userId))
  })
}

/** Forgets the connection, drops its unsent deliveries and switches the service off. */
export async function removeConnection(userId: string, target: ScrobbleTarget): Promise<void> {
  await db.transaction(async (tx) => {
    await dropPending(tx, userId, target)
    await tx.update(users).set({
      settings: sql`${users.settings}
        || jsonb_build_object('secrets', coalesce(${users.settings}->'secrets', '{}'::jsonb) - ${target}::text)
        || jsonb_build_object(${switchFor[target]}::text, false)`,
      updatedAt: new Date(),
    }).where(eq(users.id, userId))
  })
}

/**
 * Records the outcome of using a connection. Only the connection that was used is
 * changed: if the user connected again meanwhile, the new one is left alone.
 */
export async function markConnection(connection: Connection, userId: string, patch: { needsAttention?: true; lastError: string | null }): Promise<void> {
  const path = sql`array['secrets', ${connection.target}::text]`
  await db.update(users).set({
    settings: sql`jsonb_set(${users.settings}, ${path}, (${users.settings} #> ${path}) || ${JSON.stringify(patch)}::jsonb)`,
  }).where(sql`${users.id} = ${userId} and ${users.settings} #>> array['secrets', ${connection.target}::text, 'credential'] = ${connection.ciphertext}`)
}
