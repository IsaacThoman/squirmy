import postgres from 'postgres'
import { getConfig } from '../config.js'

/**
 * Session advisory locks, for work that one process at a time may do: run an import, apply
 * an organize batch in a root, watch the inbox.
 *
 * Every lock this process holds lives on one connection of its own, never on a connection
 * reserved from the query pool. A holder works for minutes (an import waits for probe,
 * ingest and matching jobs) and needs pooled connections for that work, so a connection
 * reserved per holder let a handful of holders take the whole pool and then wait forever
 * for a connection none of them would give back: parallel acquisitions deadlocked that way.
 * The lock connection only ever runs the short lock and unlock statements.
 *
 * Postgres lets one session take the same key twice, so the keys held here are also kept
 * in memory and a second take in this process fails at once, as it would in another.
 *
 * When the connection drops, Postgres releases its locks and the holders carry on without
 * knowing, as they did with a reserved connection; postgres.js reconnects for the next
 * statement. Lifetime and idle limits are off so the connection is never recycled under
 * a holder.
 */

let client: postgres.Sql | undefined
let sealed = false
const held = new Set<string>()

function lockSql(): postgres.Sql {
  if (sealed) throw new Error('The database is closed')
  client ??= postgres(getConfig().DATABASE_URL, {
    max: 1,
    idle_timeout: 0,
    max_lifetime: null,
    prepare: false,
    connection: { application_name: 'squirmy-locks' },
    onnotice: () => {},
  })
  return client
}

export type SessionLock = { release(): Promise<void> }

/**
 * Takes the lock for `key` without waiting: null when this or another process holds it.
 * Keys are hashed with `hashtext`, as the locks taken before this module were, so a
 * process of the previous version and one of this version still exclude each other.
 */
export async function trySessionLock(key: string): Promise<SessionLock | null> {
  if (held.has(key)) return null
  held.add(key)
  let locked = false
  try {
    const [row] = await lockSql()<{ locked: boolean }[]>`select pg_try_advisory_lock(hashtext(${key})) as locked`
    locked = Boolean(row?.locked)
  } finally {
    if (!locked) held.delete(key)
  }
  if (!locked) return null
  let released = false
  return {
    async release() {
      if (released) return
      released = true
      try {
        // A closed connection took its locks with it.
        if (client) await client`select pg_advisory_unlock(hashtext(${key}))`
      } finally {
        held.delete(key)
      }
    },
  }
}

/** Runs `work` under the lock for `key`. `{ locked: false }` without running it when the lock is held. */
export async function withSessionLock<T>(key: string, work: () => Promise<T>): Promise<{ locked: true; value: T } | { locked: false }> {
  const lock = await trySessionLock(key)
  if (!lock) return { locked: false }
  try {
    return { locked: true, value: await work() }
  } finally {
    await lock.release()
  }
}

/** Closes the lock connection, releasing every lock. `final` works as it does for `closeDb`. */
export async function closeLocks({ final = false }: { final?: boolean } = {}) {
  sealed = final
  const current = client
  client = undefined
  held.clear()
  await current?.end({ timeout: 5 })
}
