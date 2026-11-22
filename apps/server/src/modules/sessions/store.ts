import { createInitialSession, joinSession, type Session, splitSession } from '@squirmy/client-core'
import { SessionQueue, type SessionSnapshot, SessionState } from '@squirmy/contracts'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '../../database/client.js'
import { playbackSessions } from '../../database/schema.js'
import { OpenPlay } from './plays.js'

/**
 * In-memory sessions, one per user, loaded lazily and written back to
 * `playback_sessions` about a second after each change.
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
  userId: string
  session: Session
  version: number
  queueVersion: number
  /** Recently applied command ids, oldest first. */
  commandIds: Set<string>
  /** The play being listened to, written to `plays` when it ends. */
  play: OpenPlay | null
  /** Recordings `requestRecording` was called for while they were preparing. */
  requested: Set<string>
  /** The current entry autoplay suggestions were last asked for, so an empty answer is not asked again. */
  autoplayAskedFor: string | null
  persistTimer: ReturnType<typeof setTimeout> | null
  /** The last write, so writes of one session never overtake each other. */
  writing: Promise<void>
}

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

/** The loaded session of `userId`, if any. */
export function loadedRecord(userId: string): SessionRecord | undefined {
  return records.get(userId)
}

/** Every loaded session. */
export function loadedRecords(): IterableIterator<SessionRecord> {
  return records.values()
}

/**
 * The session of `userId`, from memory or else from the database. A stored session that
 * does not match the contract schemas is replaced by a fresh one. Call inside `serial`.
 * `onLoad` runs once for a session read from the database, before it is returned.
 */
export async function loadRecord(userId: string, onLoad: (record: SessionRecord) => Promise<void>): Promise<SessionRecord> {
  const loaded = records.get(userId)
  if (loaded) return loaded
  const [row] = await db.select().from(playbackSessions).where(eq(playbackSessions.userId, userId))
  const stored = row ? StoredSession.safeParse(row.state) : null
  const session = stored?.success ? joinSession(stored.data.state, stored.data.queue) : createInitialSession()
  const play = stored?.success ? stored.data.play : null
  const record: SessionRecord = {
    userId,
    session,
    version: row?.version ?? 0,
    queueVersion: row?.queueVersion ?? 0,
    commandIds: new Set(stored?.success ? stored.data.commandIds : []),
    play: play && play.entryId === session.current?.id ? play : null,
    requested: new Set(),
    autoplayAskedFor: null,
    persistTimer: null,
    writing: Promise.resolve(),
  }
  records.set(userId, record)
  if (stored?.success) await onLoad(record)
  return record
}

export function snapshotOf(record: SessionRecord): SessionSnapshot {
  const { state, queue } = splitSession(record.session)
  return { version: record.version, queueVersion: record.queueVersion, state, queue }
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

/** Writes the session now, after any write already in flight. */
export function persist(record: SessionRecord): Promise<void> {
  const { state, queue } = splitSession(record.session)
  const commandIds = [...record.commandIds].slice(-STORED_COMMANDS)
  const values = { state: { state, queue, play: record.play, commandIds }, version: record.version, queueVersion: record.queueVersion, updatedAt: new Date() }
  record.writing = record.writing.catch(() => undefined).then(async () => {
    await db.insert(playbackSessions).values({ userId: record.userId, ...values })
      .onConflictDoUpdate({ target: playbackSessions.userId, set: values })
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
