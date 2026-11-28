import { createInitialSession, joinSession, type Session, splitSession } from '@squirmy/client-core'
import { SessionQueue, type SessionSnapshot, SessionState, type SignalPath } from '@squirmy/contracts'
import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '../../database/client.js'
import { detachedSessions, playbackSessions } from '../../database/schema.js'
import { OpenPlay } from './plays.js'
import type { UndoStep } from './undo.js'

/**
 * In-memory sessions, loaded lazily and written back about a second after each change:
 * each user's shared session to `playback_sessions`, and the own session of each detached
 * device to `detached_sessions`. Each is loaded on first use (a user's shared session at
 * their first hello, a device's own at its) and stays loaded until shutdown or, for an own
 * session, until it is discarded.
 *
 * This assumes a single API process: the copy in memory is the truth, and the table is
 * only where it survives a restart. Running two API processes against one database would
 * give each its own diverging copy.
 */

/** Writes happen this long after the first unsaved change. */
const PERSIST_DELAY_MS = 1000
/** Command ids remembered per session for de-duplication. */
const COMMAND_MEMORY = 1000
/**
 * The most recent command ids written with the session. A client re-sends the commands it
 * has seen no state for after every reconnect, a restart included; stored with the state
 * they produced, they are recognized exactly when their effect survived.
 */
const STORED_COMMANDS = 100

export type SessionRecord = {
  /** `sessionKey(userId, deviceId)`. */
  key: string
  userId: string
  /** The detached device whose own session this is; null for the user's shared session. */
  deviceId: string | null
  session: Session
  version: number
  queueVersion: number
  /** Recently applied command ids, oldest first. */
  commandIds: Set<string>
  /** The play being listened to, written to `plays` when it ends. */
  play: OpenPlay | null
  /**
   * Recordings `requestRecording` was called for while they were preparing, with the
   * origin of the latest request: `play` once the entry was current, else `prefetch`.
   */
  requested: Map<string, 'play' | 'prefetch'>
  /**
   * Current entries skipped because their fetch failed since a current entry was last
   * ready (or the user started something new). Enough in a row pause the session.
   */
  failedInARow: number
  /**
   * Distinct tracks skipped as not available since the session last had something
   * delivered (a current entry ready, or any of its fetches done) or the user started
   * something new. Enough of them pause the session; they also tell a run that ran out of
   * queue from one song at its end.
   */
  skippedTracks: Set<string>
  /**
   * Tracks whose fetch failed in a provider outage while not current, with the current
   * entry at the time: they stay preparing and are not asked for again until the current
   * entry changes, so a failing provider is not asked over and over.
   */
  deferred: Map<string, string | null>
  /** The current entry autoplay suggestions were last asked for, so an empty answer is not asked again. */
  autoplayAskedFor: string | null
  /**
   * The entry the listener started by name (a song clicked in a list or the queue), while it
   * is still the one they asked for. If it cannot be fetched, playback stays on it rather than
   * starting a song they did not pick. Kept in memory only, like the counts above.
   */
  picked: string | null
  /** Queue edits `undo` can undo, the newest last (see "Undo" in the session contract). In memory only: a restart forgets them. */
  undo: UndoStep[]
  /**
   * What the active device last said it plays (`session:signal`). Kept in memory only and
   * passed on only while it is about the current entry on the active device.
   */
  signal: SignalPath | null
  persistTimer: ReturnType<typeof setTimeout> | null
  /** The last write, so writes of one session never overtake each other. */
  writing: Promise<void>
  /** Own sessions: when the device was last connected (session clock). Written with the session. */
  lastSeenAt: number
  /** Discarded own session: forgotten, its row deleted, and never written again. */
  discarded: boolean
}

/** Identifies a session among the loaded ones: the user's shared session, or a device's own. */
export function sessionKey(userId: string, deviceId: string | null = null): string {
  return deviceId === null ? userId : `${userId}/${deviceId}`
}

type StoredSession = z.infer<typeof StoredSession>
const StoredSession = z.object({ state: SessionState, queue: SessionQueue, play: OpenPlay.nullish(), commandIds: z.array(z.string()).optional() })

const records = new Map<string, SessionRecord>()
const chains = new Map<string, Promise<unknown>>()

/**
 * Runs `task` after every earlier task of the same user has finished. Everything that
 * reads or changes a session goes through here, so commands apply in arrival order even
 * when one of them waits on the database.
 */
export function serial<T>(userId: string, task: () => Promise<T> | T): Promise<T> {
  const result = (chains.get(userId) ?? Promise.resolve()).then(task)
  const tail = result.then(() => undefined, () => undefined)
  chains.set(userId, tail)
  void tail.then(() => {
    if (chains.get(userId) === tail) chains.delete(userId)
  })
  return result
}

/** The loaded shared session of `userId`, if any. */
export function loadedRecord(userId: string): SessionRecord | undefined {
  return records.get(sessionKey(userId))
}

/** The loaded own session of a detached device, if any. */
export function loadedOwn(userId: string, deviceId: string): SessionRecord | undefined {
  return records.get(sessionKey(userId, deviceId))
}

/** The loaded session under `key`, if any. */
export function recordOf(key: string): SessionRecord | undefined {
  return records.get(key)
}

/** Every loaded session, shared and own. */
export function loadedRecords(): IterableIterator<SessionRecord> {
  return records.values()
}

/** The session, open play and command ids of a stored session; the play only while its entry is still current. */
function restored(stored: StoredSession): Pick<SessionRecord, 'session' | 'play' | 'commandIds'> {
  const session = joinSession(stored.state, stored.queue)
  const play = stored.play && stored.play.entryId === session.current?.id ? stored.play : null
  return { session, play, commandIds: new Set(stored.commandIds ?? []) }
}

function newRecord(userId: string, deviceId: string | null, fields: Pick<SessionRecord, 'session' | 'version' | 'queueVersion'> & Partial<SessionRecord>): SessionRecord {
  return {
    key: sessionKey(userId, deviceId),
    userId,
    deviceId,
    commandIds: new Set(),
    play: null,
    requested: new Map(),
    failedInARow: 0,
    skippedTracks: new Set(),
    deferred: new Map(),
    autoplayAskedFor: null,
    picked: null,
    undo: [],
    signal: null,
    persistTimer: null,
    writing: Promise.resolve(),
    lastSeenAt: 0,
    discarded: false,
    ...fields,
  }
}

/**
 * The shared session of `userId`, from memory or else from the database. A stored session
 * that does not match the contract schemas is replaced by a fresh one. Call inside
 * `serial`. `onLoad` runs once for a session read from the database, before it is returned.
 */
export async function loadRecord(userId: string, onLoad: (record: SessionRecord) => Promise<void>): Promise<SessionRecord> {
  const loaded = records.get(sessionKey(userId))
  if (loaded) return loaded
  const [row] = await db.select().from(playbackSessions).where(eq(playbackSessions.userId, userId))
  const stored = row ? StoredSession.safeParse(row.state) : null
  const record = newRecord(userId, null, {
    ...(stored?.success ? restored(stored.data) : { session: createInitialSession() }),
    version: row?.version ?? 0,
    queueVersion: row?.queueVersion ?? 0,
  })
  records.set(record.key, record)
  if (stored?.success) await onLoad(record)
  return record
}

/**
 * Loads the stored own session of a detached device into memory. Undefined when none is
 * stored; one that does not match the contract schemas is deleted and counts as none.
 * Call inside `serial`, and only when it is not loaded already.
 */
export async function readOwn(userId: string, deviceId: string): Promise<SessionRecord | undefined> {
  const where = and(eq(detachedSessions.userId, userId), eq(detachedSessions.deviceId, deviceId))
  const [row] = await db.select().from(detachedSessions).where(where)
  if (!row) return undefined
  const stored = StoredSession.safeParse(row.state)
  if (!stored.success) {
    await db.delete(detachedSessions).where(where)
    return undefined
  }
  const record = newRecord(userId, deviceId, {
    ...restored(stored.data),
    version: row.version,
    queueVersion: row.queueVersion,
    lastSeenAt: row.lastSeenAt.getTime(),
  })
  records.set(record.key, record)
  return record
}

/** Writes a new own session for a detached device, then adds it to the loaded ones. When the write fails, nothing is added. */
export async function createOwn(
  userId: string,
  deviceId: string,
  fields: Pick<SessionRecord, 'session' | 'version' | 'queueVersion' | 'lastSeenAt'> & Partial<SessionRecord>,
): Promise<SessionRecord> {
  const record = newRecord(userId, deviceId, fields)
  await persist(record)
  records.set(record.key, record)
  return record
}

/** The stored own sessions of a user's devices, loaded or not, with when each device was last seen. */
export async function storedOwn(userId: string): Promise<{ deviceId: string; lastSeenAt: number }[]> {
  const rows = await db.select({ deviceId: detachedSessions.deviceId, lastSeenAt: detachedSessions.lastSeenAt })
    .from(detachedSessions).where(eq(detachedSessions.userId, userId))
  return rows.map(row => ({ deviceId: row.deviceId, lastSeenAt: records.get(sessionKey(userId, row.deviceId))?.lastSeenAt ?? row.lastSeenAt.getTime() }))
}

/**
 * Deletes an own session's row, after any write in flight, then forgets it. When the
 * delete fails this throws and the session stays loaded as it was. Its open play is the
 * caller's to close. Call inside `serial`.
 */
export async function discardOwn(record: SessionRecord): Promise<void> {
  const timer = record.persistTimer
  if (timer) clearTimeout(timer)
  record.persistTimer = null
  record.discarded = true
  const where = and(eq(detachedSessions.userId, record.userId), eq(detachedSessions.deviceId, record.deviceId!))
  const deleting = record.writing.catch(() => undefined).then(async () => {
    await db.delete(detachedSessions).where(where)
  })
  record.writing = deleting.catch(() => undefined)
  try {
    await deleting
  } catch (error) {
    record.discarded = false
    if (timer) persist(record).catch(() => undefined)
    throw error
  }
  if (records.get(record.key) === record) records.delete(record.key)
}

/** Deletes the row of an own session that is not loaded. */
export async function deleteStoredOwn(userId: string, deviceId: string): Promise<void> {
  await db.delete(detachedSessions).where(and(eq(detachedSessions.userId, userId), eq(detachedSessions.deviceId, deviceId)))
}

export function snapshotOf(record: SessionRecord): SessionSnapshot {
  const { state, queue } = splitSession(record.session)
  const scope = record.deviceId === null ? { type: 'shared' as const } : { type: 'device' as const, deviceId: record.deviceId }
  return { version: record.version, queueVersion: record.queueVersion, state, queue, scope }
}

/** Remembers an applied command id, forgetting the oldest beyond the limit. */
export function rememberCommand(record: SessionRecord, commandId: string): void {
  record.commandIds.add(commandId)
  if (record.commandIds.size > COMMAND_MEMORY) record.commandIds.delete(record.commandIds.values().next().value!)
}

/** Schedules a write of the session unless one is already scheduled. */
export function schedulePersist(record: SessionRecord, onError: (error: unknown) => void): void {
  if (record.persistTimer) return
  record.persistTimer = setTimeout(() => {
    record.persistTimer = null
    persist(record).catch(onError)
  }, PERSIST_DELAY_MS)
}

/** Writes the session now, after any write already in flight. A discarded one is not written. */
export function persist(record: SessionRecord): Promise<void> {
  if (record.discarded) return record.writing
  const { state, queue } = splitSession(record.session)
  const commandIds = [...record.commandIds].slice(-STORED_COMMANDS)
  const values = { state: { state, queue, play: record.play, commandIds }, version: record.version, queueVersion: record.queueVersion, updatedAt: new Date() }
  const { userId, deviceId } = record
  const lastSeenAt = new Date(record.lastSeenAt)
  record.writing = record.writing.catch(() => undefined).then(async () => {
    if (record.discarded) return
    if (deviceId === null) {
      await db.insert(playbackSessions).values({ userId, ...values })
        .onConflictDoUpdate({ target: playbackSessions.userId, set: values })
    } else {
      await db.insert(detachedSessions).values({ userId, deviceId, ...values, lastSeenAt })
        .onConflictDoUpdate({ target: [detachedSessions.userId, detachedSessions.deviceId], set: { ...values, lastSeenAt } })
    }
  })
  return record.writing
}

/**
 * Waits for queued tasks, runs `beforeUnload`, writes every session with unsaved changes
 * or an open play, and forgets them all.
 * The next use loads from the database again.
 */
export async function unloadAll(beforeUnload: (record: SessionRecord) => Promise<void>): Promise<void> {
  await Promise.all(chains.values())
  for (const record of records.values()) {
    const unsaved = Boolean(record.persistTimer) || record.play !== null
    if (record.persistTimer) clearTimeout(record.persistTimer)
    record.persistTimer = null
    await beforeUnload(record)
    // The open play's count moved on in `beforeUnload`, so it is stored as it is now.
    if (unsaved) await persist(record)
    // A failed scheduled write was already reported.
    await record.writing.catch(() => undefined)
  }
  records.clear()
}
