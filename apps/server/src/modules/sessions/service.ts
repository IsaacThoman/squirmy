import {
  type AnySessionCommand, bringSession, forkSession, positionAt, queueChanged, reduceSession, type Session, splitSession,
} from '@squirmy/client-core'
import {
  COMMAND_TRACK_LIMIT, CommandEnvelope, EngineReport, QUEUE_LIMIT, SessionAttach, SessionDetach,
  type CommandAck, type DeviceInfo, type QueueEntry, type SessionCapability, type SessionCommand, type SessionHello, type SessionHelloAck,
  type SessionMoveAck, type SessionSnapshot,
} from '@squirmy/contracts'
import { and, eq } from 'drizzle-orm'
import { getConfig } from '../../config.js'
import { db } from '../../database/client.js'
import { devices } from '../../database/schema.js'
import { newId } from '../../lib/ids.js'
import type { RealtimeServer } from '../../realtime/index.js'
import { requestRecording } from '../acquisition/coverage.js'
import { rememberDevice } from '../auth/service.js'
import { suggestAutoplay } from '../radio/suggest.js'
import { lookupTracks, trustSeeds } from './entries.js'
import { countUntil, followPlay, insertPlay, isCompleted, notifyPlayStart, type OpenPlay, savePlay } from './plays.js'
import { connectedDevice, connectedDeviceIds, deviceSockets, joinDevice, leaveDevice, listDevices, seeDevice, socketDevices } from './presence.js'
import {
  createOwn, deleteStoredOwn, discardOwn, loadedOwn, loadedRecord, loadedRecords, loadRecord, persist, readOwn, recordOf, rememberCommand,
  schedulePersist, serial, type SessionRecord, sessionKey, snapshotOf, storedOwn, unloadAll,
} from './store.js'

/** A reported position this far from the computed one re-anchors the session. */
const DRIFT_THRESHOLD_MS = 1000
/** Autoplay is refilled when fewer entries than this are left in the queue. */
const AUTOPLAY_LOW_WATER = 3
const AUTOPLAY_BATCH = 10
const AUTOPLAY_SEEDS = 10
/**
 * On-demand entries are requested while they are current or among this many next. Fetches
 * take seconds, so a few ahead keep skips and track changes from waiting on one.
 */
const PREPARE_AHEAD = 5
/**
 * Current entries whose fetch fails in a row, with none ready in between, before the
 * session pauses instead of skipping on: during a provider outage every fetch fails, and
 * skipping would run down the queue one failure at a time.
 */
const FAILURES_BEFORE_PAUSE = 3
/** Own sessions a user may keep; detaching beyond this drops the one gone longest, unless all are connected. */
const MAX_DETACHED = 8
/** An own session is discarded once its device has not been seen for this long. */
const DETACHED_KEEP_MS = 7 * 24 * 60 * 60_000
const CAPABILITIES: SessionCapability[] = ['detach']

/** Schedules and cancels the grace timers. */
export type SessionTimers = { set: (callback: () => void, ms: number) => unknown; clear: (handle: unknown) => void }

const realTimers: SessionTimers = {
  set: (callback, ms) => setTimeout(callback, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}
const settings: { deviceGraceMs: number; now: () => number; timers: SessionTimers } = { deviceGraceMs: 20_000, now: () => Date.now(), timers: realTimers }
const graceTimers = new Map<string, unknown>()
/** Writes of closed plays still in flight, which shutdown waits for. */
const savingPlays = new Set<Promise<void>>()
let io: RealtimeServer | null = null

/**
 * Overrides timing for tests. `deviceGraceMs`: how long an active device may be gone
 * before `deviceLost`. `now`: the session clock (server epoch milliseconds), which
 * anchors positions, answers `serverTime` in hellos and times plays. `timers`: what
 * schedules the grace period, so a test can fire it instead of waiting; `null` restores
 * the real ones.
 */
export function configureSessions(options: Partial<Omit<typeof settings, 'timers'>> & { timers?: SessionTimers | null }): void {
  const { timers, ...rest } = options
  Object.assign(settings, rest)
  if (timers !== undefined) settings.timers = timers ?? realTimers
}

/** Sets the socket.io server that session updates are broadcast through. */
export function setRealtimeServer(server: RealtimeServer): void {
  io = server
}

function report(error: unknown): void {
  if (getConfig().LOG_LEVEL !== 'silent') console.error('[sessions]', error)
}

/** Every authenticated socket of the user: device lists and invalidations go here. */
const userRoom = (userId: string) => `user:${userId}`
const SESSION_ROOM = 'session:'
/** The sockets in a session, which its updates go to: a detached device's own, or all the other ones of the user. */
const sessionRoom = (record: SessionRecord) => `${SESSION_ROOM}${record.key}`

function load(userId: string): Promise<SessionRecord> {
  return loadRecord(userId, recheck)
}

/**
 * Brings a session read from the database up to date: entries that were preparing may
 * be ready or unavailable by now, and its active device may not come back.
 */
async function recheck(record: SessionRecord): Promise<void> {
  const preparing = [...new Set(entriesOf(record.session).filter(entry => entry.state === 'preparing').map(entry => entry.trackId))]
  const tracks = await lookupTracks(preparing)
  for (const trackId of preparing) {
    const availability = tracks.get(trackId)?.availability ?? 'none'
    if (availability === 'server') applyServer(record, { type: 'setEntryState', trackId, state: 'ready' })
    else if (availability === 'none') applyFailure(record, trackId)
  }
  const active = record.session.activeDeviceId
  if (active && !connectedDevice(record.userId, active)) startGrace(record, active)
  afterChange(record)
}

/** The session a connected device is in: its own while detached, else the shared one. */
async function sessionOf(userId: string, deviceId: string): Promise<SessionRecord> {
  return loadedOwn(userId, deviceId) ?? await load(userId)
}

/** What `DeviceInfo.detached` says of an own session. */
function ownSummary(session: Session): NonNullable<DeviceInfo['detached']> {
  return { playing: session.playing && session.current !== null, trackId: session.current?.trackId ?? null, albumId: session.current?.albumId ?? null }
}

/** The user's connected devices as every client sees them. The shared session is loaded from the first hello on. */
function deviceList(userId: string, currentDeviceId: string | null): DeviceInfo[] {
  return listDevices(userId, loadedRecord(userId)?.session.activeDeviceId ?? null, currentDeviceId, (deviceId) => {
    const own = loadedOwn(userId, deviceId)
    return own ? ownSummary(own.session) : undefined
  })
}

/**
 * Sends the device list to the user's sockets, but `exceptSocketId`. Each socket gets it
 * as its own device sees it (`isCurrent`), so the list goes out per socket; a socket that
 * has not said hello yet gets it with no current device.
 */
export function emitDevices(userId: string, exceptSocketId?: string): void {
  const sockets = io?.of('/').adapter.rooms.get(userRoom(userId))
  if (!io || !sockets) return
  const devices = socketDevices(userId)
  const lists = new Map<string | null, DeviceInfo[]>()
  for (const socketId of sockets) {
    if (socketId === exceptSocketId) continue
    const deviceId = devices.get(socketId) ?? null
    let list = lists.get(deviceId)
    if (!list) lists.set(deviceId, list = deviceList(userId, deviceId))
    io.to(socketId).emit('devices', list)
  }
}

/**
 * Notes that `deviceId` said something now. Its other devices get the list again once
 * the last-seen time they have is a minute or more behind.
 */
export function noteSeen(userId: string, deviceId: string | null): void {
  if (deviceId && seeDevice(userId, deviceId, settings.now())) emitDevices(userId)
}

/** A hello's answer for `deviceId`, a device in `record`'s session. */
function helloAck(record: SessionRecord, deviceId: string): SessionHelloAck {
  return { serverTime: settings.now(), snapshot: snapshotOf(record), devices: deviceList(record.userId, deviceId), capabilities: CAPABILITIES }
}

/**
 * Puts sockets in the room of `record`'s session and takes them out of any other. Rooms
 * are local to this process, which the store assumes is the only one.
 */
function joinSessionRoom(socketIds: readonly string[], record: SessionRecord): void {
  const target = sessionRoom(record)
  for (const socketId of socketIds) {
    const socket = io?.of('/').sockets.get(socketId)
    if (!socket) continue
    for (const joined of socket.rooms) {
      if (joined.startsWith(SESSION_ROOM) && joined !== target) void socket.leave(joined)
    }
    void socket.join(target)
  }
}

function entriesOf(session: Session): QueueEntry[] {
  return [...(session.current ? [session.current] : []), ...session.queue, ...session.autoplayQueue, ...session.history, ...session.playedInCycle]
}

type Change = { queue: boolean; devices: boolean }

/**
 * Makes `next` the session: bumps versions, follows the open play up to `now` (when the
 * change took effect) and schedules a write. Null when nothing changed. `devices`: the
 * change shows in the device list (the shared session's active device, or what a
 * detached device plays).
 */
function commit(record: SessionRecord, next: Session, now = settings.now()): Change | null {
  const previous = record.session
  if (next === previous) return null
  const queue = queueChanged(previous, next)
  record.version += 1
  if (queue) record.queueVersion += 1
  record.session = next
  if (next.current?.state === 'ready') record.failedInARow = 0
  const { open, closed } = followPlay(record.play, previous, next, now)
  if (open && open !== record.play) notifyPlayStart(record.userId, open)
  record.play = open
  if (closed) keepSaving(record.userId, closed)
  if (record.deviceId !== null && connectedDevice(record.userId, record.deviceId)) record.lastSeenAt = now
  schedulePersist(record, report)
  const devices = record.deviceId === null
    ? previous.activeDeviceId !== next.activeDeviceId
    : JSON.stringify(ownSummary(previous)) !== JSON.stringify(ownSummary(next))
  return { queue, devices }
}

/** Writes a closed play in the background; shutdown waits for it. */
function keepSaving(userId: string, play: OpenPlay): void {
  const saving = savePlay(userId, play).catch(report).finally(() => savingPlays.delete(saving))
  savingPlays.add(saving)
}

/** Counts a session's open play up to now and writes it. */
function closePlay(record: SessionRecord): void {
  const { play } = record
  if (!play) return
  record.play = null
  countUntil(play, record.session, settings.now())
  keepSaving(record.userId, play)
}

/** Sends a committed change to the sockets in the session: the queue half first, when it changed. */
function broadcast(record: SessionRecord, change: Change): void {
  if (!io) return
  const target = io.to(sessionRoom(record))
  const { state, queue } = splitSession(record.session)
  if (change.queue) target.emit('session:queue', { version: record.version, queueVersion: record.queueVersion, queue })
  target.emit('session:state', { version: record.version, state })
  if (change.devices) emitDevices(record.userId)
}

/** Applies a server-issued command under a fresh command id and broadcasts the result. */
function applyServer(record: SessionRecord, command: AnySessionCommand, now = settings.now()): void {
  const change = commit(record, reduceSession(record.session, { command, now, commandId: newId() }), now)
  if (!change) return
  broadcast(record, change)
  afterChange(record)
}

/** Work that follows a change without holding it up: preparing on-demand entries and refilling autoplay. */
function afterChange(record: SessionRecord): void {
  requestUpcoming(record)
  refillAutoplay(record)
}

type Wanted = { entry: QueueEntry; origin: 'play' | 'prefetch' }

/**
 * The entries to have fetched: the current one as `play` and the next `PREPARE_AHEAD` as
 * `prefetch`. None while the session is stopped on an entry that failed (after a run of
 * failures, or at the end of the queue): more fetches then would most likely fail too.
 */
function toPrepare(session: Session): Wanted[] {
  const { current, queue, autoplay, autoplayQueue, playing } = session
  if (current?.state === 'failed' && !playing) return []
  const upcoming = [...queue, ...(autoplay ? autoplayQueue : [])].slice(0, PREPARE_AHEAD)
  return [
    ...(current ? [{ entry: current, origin: 'play' as const }] : []),
    ...upcoming.map(entry => ({ entry, origin: 'prefetch' as const })),
  ].filter(({ entry }) => entry.state === 'preparing')
}

/**
 * Asks acquisition for the entries `toPrepare` names, current first, so a provider with
 * few slots starts what the user is waiting for before what comes later. The requests go
 * out one after another, so jobs are created in queue order, and one the session no
 * longer wants by its turn (skipped past, or the session stopped) is not sent. An entry
 * asked for as a prefetch is asked for again as `play` once it is current; the second
 * request joins the job already in flight.
 */
function requestUpcoming(record: SessionRecord): void {
  const { userId } = record
  const asks: (() => Promise<void>)[] = []
  for (const { entry, origin } of toPrepare(record.session)) {
    const asked = record.requested.get(entry.trackId)
    if (asked === 'play' || asked === origin) continue
    const recordingId = entry.trackId
    record.requested.set(recordingId, origin)
    const request = { userId, recordingId, albumId: entry.albumId, origin }
    asks.push(async () => {
      const wanted = recordOf(record.key) === record && toPrepare(record.session).some(({ entry }) => entry.trackId === recordingId)
      if (!wanted) {
        if (record.requested.get(recordingId) === origin) record.requested.delete(recordingId)
        return
      }
      await requestRecording(request).catch((error: unknown) => {
        report(error)
        // A request that threw was never made, so no outcome will come: fail the entries
        // rather than leave them preparing. A job that did start still marks them ready.
        return serial(userId, () => {
          const latest = recordOf(record.key)
          if (latest?.requested.delete(recordingId)) applyFailure(latest, recordingId)
        })
      }).catch(report)
    })
  }
  if (asks.length) void asks.reduce((chain, ask) => chain.then(ask), Promise.resolve())
}

/**
 * Applies a failed fetch of `trackId`. Entries further down are only marked failed, with
 * nothing said: the session skips them quietly when it reaches them. A preparing current
 * entry is skipped, unless it is the `FAILURES_BEFORE_PAUSE`th in a row, or the fetch failed
 * for a known `reason` (the provider is failing, so the next would fail too): then the
 * session pauses on it with the rest of the queue kept, and the user gets one
 * `playback.unavailable` (in that session only, with the reason) rather than a notice per
 * track. Nothing more is fetched until the user plays again (see `toPrepare`), and `play`
 * moves on from the failed entry.
 */
function applyFailure(record: SessionRecord, trackId: string, reason?: string): void {
  const { current } = record.session
  const skipsCurrent = current?.trackId === trackId && current.state === 'preparing'
  if (skipsCurrent) record.failedInARow += 1
  if (!current || !skipsCurrent || (record.failedInARow < FAILURES_BEFORE_PAUSE && !reason)) {
    applyServer(record, { type: 'setEntryState', trackId, state: 'failed' })
    return
  }
  record.failedInARow = 0
  const now = settings.now()
  const paused = reduceSession(record.session, { command: { type: 'pause' }, now, commandId: newId() })
  // The reducer moves past a current entry that fails. Marked here first, the entry stays
  // current, and `setEntryState` only marks its other entries.
  const held: Session = { ...paused, current: { ...current, state: 'failed' }, positionMs: 0, anchorAt: now, stalled: false }
  const change = commit(record, reduceSession(held, { command: { type: 'setEntryState', trackId, state: 'failed' }, now, commandId: newId() }), now)
  // To the session's own sockets: a detached device's outage is not news to the others.
  // Sent before the state that pauses, so a client shows the pause with its reason rather
  // than a generic notice first (see `outage` in client-core's session client).
  io?.to(sessionRoom(record)).emit('event', { type: 'playback.unavailable', trackId, reason: reason ?? null })
  if (change) {
    broadcast(record, change)
    afterChange(record)
  }
}

/**
 * Asks the radio module for more tracks once the queue runs low and the autoplay queue
 * is empty. Asked at most once per current entry, so an empty answer is not repeated.
 * Refilling only an empty autoplay queue keeps the ids of entries a device may have
 * preloaded.
 */
function refillAutoplay(record: SessionRecord): void {
  const { userId, session } = record
  const { current } = session
  if (!session.autoplay || !current || session.autoplayQueue.length || session.queue.length >= AUTOPLAY_LOW_WATER) return
  if (record.autoplayAskedFor === current.id) return
  record.autoplayAskedFor = current.id
  const seeds = [...session.history.slice(-AUTOPLAY_SEEDS + 1), current].map(entry => entry.trackId)
  const exclude = [...new Set([current, ...session.queue].map(entry => entry.trackId))]
  suggestAutoplay({ userId, seeds, exclude, limit: AUTOPLAY_BATCH })
    .then(tracks => serial(userId, () => {
      const latest = recordOf(record.key)
      if (!tracks.length || latest !== record || !latest.session.autoplay || latest.session.autoplayQueue.length) return
      applyServer(latest, { type: 'setAutoplayQueue', tracks })
    }))
    .catch(report)
}

/**
 * Gives an active device of `record`'s session that went away at `lostAt` the grace
 * period to come back. When it does not, the session pauses where it was then (or at the
 * last change since): its audio most likely stopped with it, and a device that played on
 * offline reclaims the session with its own position when it returns.
 */
function startGrace(record: SessionRecord, deviceId: string, lostAt = settings.now()): void {
  const { userId } = record
  const key = `${record.key}#${deviceId}`
  if (graceTimers.has(key)) return
  graceTimers.set(key, settings.timers.set(() => {
    graceTimers.delete(key)
    serial(userId, () => {
      // Looked up again: the session may have been unloaded and loaded since.
      const latest = recordOf(record.key)
      if (!latest || connectedDevice(userId, deviceId)) return
      applyServer(latest, { type: 'deviceLost', deviceId }, Math.min(settings.now(), Math.max(lostAt, latest.session.anchorAt)))
    }).catch(report)
  }, settings.deviceGraceMs))
}

/** Cancels the grace period of a device in the shared session and in its own. */
function cancelGrace(userId: string, deviceId: string): void {
  for (const key of [`${sessionKey(userId)}#${deviceId}`, `${sessionKey(userId, deviceId)}#${deviceId}`]) {
    if (graceTimers.has(key)) settings.timers.clear(graceTimers.get(key))
    graceTimers.delete(key)
  }
}

/**
 * Discards an own session for good: its row goes, then its play closes. When the row
 * cannot be deleted this throws and the session stays as it was.
 */
async function discard(record: SessionRecord): Promise<void> {
  await discardOwn(record)
  cancelGrace(record.userId, record.deviceId!)
  closePlay(record)
}

/** Discards a stored own session, whether loaded or not. */
async function discardStored(userId: string, deviceId: string): Promise<void> {
  const loaded = loadedOwn(userId, deviceId)
  if (loaded) await discard(loaded)
  else await deleteStoredOwn(userId, deviceId)
}

/**
 * Where a device whose first socket says hello goes: its stored own session, unless the
 * hello is from a client that cannot detach (`detached` absent) or the session is past
 * the keep time, which discards it. `ended` is set when the client believed it was
 * detached and is not.
 */
async function placeReturning(userId: string, deviceId: string, believed: boolean | undefined): Promise<{ own?: SessionRecord; ended?: 'expired' | 'missing' }> {
  await pruneExpired(userId, deviceId)
  const loaded = loadedOwn(userId, deviceId)
  const own = loaded ?? await readOwn(userId, deviceId)
  if (believed === undefined) {
    if (own) await discard(own)
    return {}
  }
  if (!own) return believed ? { ended: 'missing' } : {}
  if (settings.now() - own.lastSeenAt > DETACHED_KEEP_MS) {
    await discard(own)
    return believed ? { ended: 'expired' } : {}
  }
  if (!loaded) await recheck(own)
  return { own }
}

// Socket protocol

/**
 * `session:hello`: records the device as connected (and in `devices`), puts the socket in
 * the session the device is in (see "Detaching" in the session contract), then calls
 * `reply` with that session's snapshot and the device list, in order with the session's
 * other updates.
 */
export function greet(userId: string, socketId: string, hello: SessionHello, reply: (ack: SessionHelloAck) => void): Promise<void> {
  const { device, canPlay } = hello
  const returning = !connectedDevice(userId, device.id)
  joinDevice(userId, socketId, device, canPlay, settings.now())
  cancelGrace(userId, device.id)
  return serial(userId, async () => {
    await rememberDevice(db, userId, device)
    const shared = await load(userId)
    // The socket may have closed while this waited; then it joins nothing.
    if (!connectedDevice(userId, device.id)) return
    const { own, ended } = returning ? await placeReturning(userId, device.id, hello.detached) : { own: loadedOwn(userId, device.id) }
    const record = own ?? shared
    if (own) {
      own.lastSeenAt = settings.now()
      schedulePersist(own, report)
    }
    joinSessionRoom([socketId], record)
    reply({ ...helloAck(record, device.id), ...(ended ? { detachedEnded: ended } : {}) })
  }).catch(report)
}

/**
 * A socket of the device closed. When it was the device's last one, the other sockets
 * get the new device list, and an active device gets the grace period to come back. A
 * detached device's own session stays loaded (it keeps its command ids) and notes when
 * the device was last seen.
 */
export function leave(userId: string, socketId: string, deviceId: string): void {
  if (!leaveDevice(userId, socketId, deviceId)) return
  serial(userId, () => {
    const own = loadedOwn(userId, deviceId)
    // Even when another socket of the device took over meanwhile: it was seen until now.
    if (own) {
      own.lastSeenAt = settings.now()
      schedulePersist(own, report)
    }
    if (!connectedDevice(userId, deviceId)) {
      for (const record of [loadedRecord(userId), own]) {
        if (record?.session.activeDeviceId === deviceId) startGrace(record, deviceId)
      }
    }
    emitDevices(userId)
  }).catch(report)
}

/**
 * `session:detach` from `deviceId` over `socketId`: gives the device a session of its
 * own, copied from the shared one (see "Detaching" in the session contract). Acks the
 * requesting socket, sends `session:moved` to the device's other sockets, then the shared
 * session's change and the new device list.
 */
export function detach(userId: string, deviceId: string | null, socketId: string, raw: unknown, ack: (reply: SessionMoveAck) => void): Promise<void> {
  if (!SessionDetach.safeParse(raw ?? {}).success) {
    ack({ ok: false, error: 'invalid_request' })
    return Promise.resolve()
  }
  return serial(userId, async () => {
    const device = deviceId ? connectedDevice(userId, deviceId) : undefined
    if (!device) return ack({ ok: false, error: 'hello_required' })
    const existing = loadedOwn(userId, device.id)
    if (existing) return ack({ ok: true, ...helloAck(existing, device.id) })
    if (!device.canPlay) return ack({ ok: false, error: 'cannot_play' })
    const others = connectedDeviceIds(userId).filter(id => id !== device.id && loadedOwn(userId, id))
    if (others.length >= MAX_DETACHED) return ack({ ok: false, error: 'too_many_detached' })
    await makeRoom(userId, device.id)

    const shared = await load(userId)
    const now = settings.now()
    const wasActive = shared.session.activeDeviceId === device.id
    // Written before anything changes: if the write fails, the device stays where it was.
    const own = await createOwn(userId, device.id, {
      session: forkSession(shared.session, device.id, now),
      version: shared.version,
      queueVersion: shared.queueVersion,
      // A command applied before the copy is in it; one re-sent after must not apply twice.
      commandIds: new Set(shared.commandIds),
      requested: new Map(shared.requested),
      failedInARow: shared.failedInARow,
      autoplayAskedFor: shared.autoplayAskedFor,
      lastSeenAt: now,
    })
    // The play goes on, now in the device's own session.
    if (wasActive && shared.play) {
      countUntil(shared.play, shared.session, now)
      own.play = shared.play
      shared.play = null
    }
    const change = wasActive ? commit(shared, reduceSession(shared.session, { command: { type: 'deviceLost', deviceId: device.id }, now, commandId: newId() })) : null
    // Written at once, so a restart never finds the shared session still playing on a detached device.
    if (change) void persist(shared).catch(report)
    moveDevice(own, device.id, socketId)
    ack({ ok: true, ...helloAck(own, device.id) })
    if (change) broadcast(shared, { ...change, devices: false })
    emitDevices(userId)
    afterChange(own)
  }).catch(error => {
    report(error)
    ack({ ok: false, error: 'internal_error' })
  })
}

/**
 * Before a device detaches: discards own sessions past the keep time, then, while the user
 * has `MAX_DETACHED` or more besides this device's, the one whose device was seen longest
 * ago among those not connected.
 */
async function makeRoom(userId: string, deviceId: string): Promise<void> {
  const kept = await pruneExpired(userId, deviceId)
  const gone = kept.filter(row => !connectedDevice(userId, row.deviceId)).sort((a, b) => a.lastSeenAt - b.lastSeenAt)
  for (let count = kept.length; count >= MAX_DETACHED && gone.length; count -= 1) await discardStored(userId, gone.shift()!.deviceId)
}

/**
 * Discards the user's own sessions whose devices are not connected and were last seen
 * over the keep time ago, other than `deviceId`'s (which its hello decides on). Runs at
 * every detach and every returning hello. Returns the stored sessions left, `deviceId`'s aside.
 */
async function pruneExpired(userId: string, deviceId: string): Promise<{ deviceId: string; lastSeenAt: number }[]> {
  const now = settings.now()
  const kept: { deviceId: string; lastSeenAt: number }[] = []
  for (const row of await storedOwn(userId)) {
    if (row.deviceId === deviceId) continue
    if (!connectedDevice(userId, row.deviceId) && now - row.lastSeenAt > DETACHED_KEEP_MS) await discardStored(userId, row.deviceId)
    else kept.push(row)
  }
  return kept
}

/**
 * `session:attach` from `deviceId` over `socketId`: puts the device back in the shared
 * session and discards its own, bringing the own session's queue along when asked. Acks
 * and notifies like `detach`.
 */
export function attach(userId: string, deviceId: string | null, socketId: string, raw: unknown, ack: (reply: SessionMoveAck) => void): Promise<void> {
  const request = SessionAttach.safeParse(raw ?? {})
  if (!request.success) {
    ack({ ok: false, error: 'invalid_request' })
    return Promise.resolve()
  }
  return serial(userId, async () => {
    const device = deviceId ? connectedDevice(userId, deviceId) : undefined
    if (!device) return ack({ ok: false, error: 'hello_required' })
    const shared = await load(userId)
    const own = loadedOwn(userId, device.id)
    if (!own) return ack({ ok: true, ...helloAck(shared, device.id) })
    const bring = request.data.bringQueue === true
    if (bring && !own.session.current && !own.session.queue.length) return ack({ ok: false, error: 'nothing_to_bring' })

    // The row goes first: if it cannot, nothing has changed.
    await discardOwn(own)
    cancelGrace(userId, device.id)
    let change: Change | null = null
    if (bring) {
      const now = settings.now()
      // Whatever the shared session played stops; the device's play goes on there.
      closePlay(shared)
      if (own.play) countUntil(own.play, own.session, now)
      shared.play = own.play
      own.play = null
      for (const commandId of own.commandIds) rememberCommand(shared, commandId)
      for (const [trackId, origin] of own.requested) {
        if (shared.requested.get(trackId) !== 'play') shared.requested.set(trackId, origin)
      }
      shared.failedInARow = own.failedInARow
      shared.autoplayAskedFor = own.autoplayAskedFor
      change = commit(shared, bringSession(shared.session, own.session, { now, commandId: newId(), deviceId: device.canPlay ? device.id : undefined }))
      if (change) void persist(shared).catch(report)
    } else {
      closePlay(own)
    }
    moveDevice(shared, device.id, socketId)
    ack({ ok: true, ...helloAck(shared, device.id) })
    if (change) broadcast(shared, { ...change, devices: false })
    emitDevices(userId)
    if (change) afterChange(shared)
  }).catch(error => {
    report(error)
    ack({ ok: false, error: 'internal_error' })
  })
}

/** Puts every socket of the device in `record`'s session, and tells those other than `socketId` with `session:moved`. */
function moveDevice(record: SessionRecord, deviceId: string, socketId: string): void {
  const sockets = deviceSockets(record.userId, deviceId)
  joinSessionRoom(sockets, record)
  const others = sockets.filter(id => id !== socketId)
  if (io && others.length) io.to(others).emit('session:moved', helloAck(record, deviceId))
}

/**
 * `session:command` from `deviceId` (null before its hello). Acks first, then broadcasts
 * the change to every socket of the user. A duplicate command id is acked with the
 * current version and not applied again; a command that changes nothing is acked the
 * same way and not broadcast.
 */
export function runCommand(userId: string, deviceId: string | null, raw: unknown, ack: (reply: CommandAck) => void): Promise<void> {
  const envelope = CommandEnvelope.safeParse(raw)
  if (!envelope.success) {
    ack({ ok: false, error: 'invalid_command' })
    return Promise.resolve()
  }
  const { commandId } = envelope.data
  return serial(userId, async () => {
    const device = deviceId ? connectedDevice(userId, deviceId) : undefined
    if (!device) return ack({ ok: false, error: 'hello_required' })
    const record = await sessionOf(userId, device.id)
    if (record.commandIds.has(commandId)) return ack({ ok: true, version: record.version })
    const command = await checkCommand(record, device.id, envelope.data.command)
    if (typeof command === 'string') return ack({ ok: false, error: command })
    const next = reduceSession(record.session, { command, now: settings.now(), commandId, deviceId: device.canPlay ? device.id : undefined })
    rememberCommand(record, commandId)
    // Something new to play starts a new count of failures.
    if (command.type === 'playTracks') record.failedInARow = 0
    const change = commit(record, next)
    ack({ ok: true, version: record.version })
    if (!change) return
    broadcast(record, change)
    afterChange(record)
  }).catch(error => {
    report(error)
    ack({ ok: false, error: 'internal_error' })
  })
}

/** Enforces who may send what, and replaces client-sent tracks with trusted entries. Returns an error code on refusal. */
async function checkCommand(record: SessionRecord, deviceId: string, command: SessionCommand): Promise<SessionCommand | string> {
  const { userId, session } = record
  switch (command.type) {
    case 'trackEnded':
      return session.activeDeviceId === deviceId ? command : 'not_active_device'
    case 'transfer': {
      // A detached device's own session has room for that device alone, and the shared one has none for it.
      const inSession = record.deviceId === null ? !loadedOwn(userId, command.deviceId) : command.deviceId === record.deviceId
      return inSession && connectedDevice(userId, command.deviceId)?.canPlay ? command : 'device_unavailable'
    }
    case 'setVolume':
      return await isKnownDevice(userId, command.deviceId) ? command : 'unknown_device'
    case 'playTracks': {
      const { seeds, indexes } = await trustSeeds(userId, command.tracks)
      if (!seeds.length) return 'nothing_playable'
      if (command.startIndex === undefined) return { ...command, tracks: seeds }
      // A start track that was dropped gives way to the next playable one, else the first.
      const startIndex = Math.max(0, indexes.findIndex(index => index >= command.startIndex!))
      return { ...command, tracks: seeds, startIndex }
    }
    case 'enqueue': {
      const { seeds } = await trustSeeds(userId, command.tracks)
      if (!seeds.length) return 'nothing_playable'
      // Checked here as well as in the reducer, which would only ignore it, so the client can say why.
      return session.queue.length + seeds.length > QUEUE_LIMIT ? 'queue_full' : { ...command, tracks: seeds }
    }
    default:
      return command
  }
}

async function isKnownDevice(userId: string, deviceId: string): Promise<boolean> {
  if (connectedDevice(userId, deviceId)) return true
  const [row] = await db.select({ id: devices.id }).from(devices).where(and(eq(devices.userId, userId), eq(devices.id, deviceId)))
  return Boolean(row)
}

/**
 * `session:report` from `deviceId`. Only the active device's reports about the current
 * entry count. One that disagrees with the computed position by more than a second, or
 * changes whether playback is stalled, re-anchors the session at the report's time;
 * the rest change nothing.
 */
export function applyReport(userId: string, deviceId: string | null, raw: unknown): Promise<void> {
  const parsed = EngineReport.safeParse(raw)
  if (!parsed.success || !deviceId) return Promise.resolve()
  const engine = parsed.data
  return serial(userId, () => {
    const record = loadedOwn(userId, deviceId) ?? loadedRecord(userId)
    const session = record?.session
    if (!record || !session || session.activeDeviceId !== deviceId) return
    if (session.current?.id !== engine.entryId || session.current.state !== 'ready') return
    const at = Math.min(engine.at, settings.now())
    // A report from before the last change, or one that has not caught up with play/pause yet.
    if (at < session.anchorAt || (engine.status !== 'paused') !== session.playing) return
    const stalled = engine.status === 'buffering' || engine.status === 'error'
    if (stalled === session.stalled && Math.abs(engine.positionMs - positionAt(session, at)) <= DRIFT_THRESHOLD_MS) return
    applyServer(record, { type: 'syncPosition', entryId: engine.entryId, positionMs: engine.positionMs, stalled }, at)
  }).catch(report)
}

// Service functions for other modules

/** The user's shared session as `GET /me/session` and Subsonic's `getPlayQueue` see it. */
export function getSnapshot(userId: string): Promise<SessionSnapshot> {
  return serial(userId, async () => snapshotOf(await load(userId)))
}

/** The user's connected devices, as `currentDeviceId` (if known) sees them. */
export function getDevices(userId: string, currentDeviceId: string | null = null): Promise<DeviceInfo[]> {
  return serial(userId, async () => {
    await load(userId)
    return deviceList(userId, currentDeviceId)
  })
}

/**
 * Replaces the shared session's queue with `trackIds`, paused at `currentId` (default the first) and
 * `positionMs`, for Subsonic's `savePlayQueue`. Tracks that cannot be played are dropped;
 * with none left the queue is cleared. At most `COMMAND_TRACK_LIMIT` ids from the current
 * one on are considered. The active device stays as it is.
 */
export function replaceQueue(userId: string, request: { trackIds: readonly string[]; currentId?: string | null; positionMs?: number }): Promise<SessionSnapshot> {
  return serial(userId, async () => {
    const record = await load(userId)
    // A client may save more ids than one playTracks carries or one query can bind. Tracks
    // before the current one are not queued, so the window starts there.
    const from = Math.max(0, request.currentId ? request.trackIds.indexOf(request.currentId) : 0)
    const trackIds = request.trackIds.slice(from, from + COMMAND_TRACK_LIMIT)
    const requested = trackIds.map(trackId => ({ trackId, durationMs: 0 }))
    const { seeds, indexes } = requested.length ? await trustSeeds(userId, requested) : { seeds: [], indexes: [] }
    const start = Math.max(0, indexes.findIndex(index => trackIds[index] === request.currentId))
    const commands: AnySessionCommand[] = seeds.length
      ? [
          { type: 'playTracks', tracks: seeds, startIndex: start, shuffle: false, seed: 0 },
          { type: 'pause' },
          { type: 'seek', positionMs: request.positionMs ?? 0 },
        ]
      : [{ type: 'clearQueue' }]
    const now = settings.now()
    const commandId = newId()
    const next = commands.reduce((session, command) => reduceSession(session, { command, now, commandId }), record.session)
    record.failedInARow = 0
    const change = commit(record, next)
    if (change) {
      broadcast(record, change)
      afterChange(record)
    }
    return snapshotOf(record)
  })
}

/**
 * Records a play another client reported (a Subsonic scrobble) with `client: 'subsonic'`:
 * by default the whole track, completed. `albumId` must be a catalog album id. Returns
 * false when the recording does not exist.
 */
export async function recordExternalPlay(
  userId: string,
  recordingId: string,
  options: { playedAt?: Date; albumId?: string | null; msPlayed?: number } = {},
): Promise<boolean> {
  const track = (await lookupTracks([recordingId])).get(recordingId)
  if (!track) return false
  const msPlayed = Math.round(options.msPlayed ?? track.durationMs)
  await insertPlay({
    userId,
    recordingId: track.id,
    albumId: options.albumId ?? null,
    deviceId: null,
    client: 'subsonic',
    startedAt: options.playedAt ?? new Date(),
    msPlayed,
    completed: isCompleted(msPlayed, track.durationMs),
  })
  return true
}

/**
 * Marks every entry of the recording ready in the loaded sessions that hold it, and
 * broadcasts. Call when an on-demand recording's file has been linked. Sessions that are
 * not loaded check their preparing entries when they load.
 */
export function markRecordingReady(recordingId: string): Promise<void> {
  return setRecordingState(recordingId, 'ready')
}

/**
 * Marks every entry of the recording failed in the loaded sessions. A preparing current
 * entry is skipped (or, after several in a row or with an outage `reason` to tell, the
 * session pauses on it); a ready one keeps playing, and only its later plays fail. Entries
 * further down are marked quietly.
 */
export function markRecordingFailed(recordingId: string, reason?: string): Promise<void> {
  return setRecordingState(recordingId, 'failed', reason)
}

async function setRecordingState(recordingId: string, state: 'ready' | 'failed', reason?: string): Promise<void> {
  // The request is answered for sessions that no longer hold the recording too, so one
  // that queues it again asks again instead of waiting on an answer that already came.
  await Promise.all([...loadedRecords()].filter(record => record.requested.has(recordingId) || holds(record, recordingId))
    .map(({ userId, key }) => serial(userId, () => {
      const record = recordOf(key)
      if (!record) return
      record.requested.delete(recordingId)
      if (!holds(record, recordingId)) return
      if (state === 'failed') applyFailure(record, recordingId, reason)
      else applyServer(record, { type: 'setEntryState', trackId: recordingId, state })
    })))
}

function holds(record: SessionRecord, recordingId: string): boolean {
  return entriesOf(record.session).some(entry => entry.trackId === recordingId)
}

/**
 * Writes every session and the plays still open, forgets them, and cancels device timers.
 * An open play stays open in the stored session: after a restart it goes on as the same
 * row, so a listen across the restart is one play.
 */
export async function stopSessions(): Promise<void> {
  for (const timer of graceTimers.values()) settings.timers.clear(timer)
  graceTimers.clear()
  for (const record of loadedRecords()) {
    if (record.deviceId === null || !connectedDevice(record.userId, record.deviceId)) continue
    record.lastSeenAt = settings.now()
    schedulePersist(record, report)
  }
  await unloadAll(async record => {
    const { play } = record
    if (!play) return
    countUntil(play, record.session, settings.now())
    await savePlay(record.userId, play).catch(report)
  })
  await Promise.all(savingPlays)
}
