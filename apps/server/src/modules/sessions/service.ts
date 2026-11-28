import {
  type AnySessionCommand, bringSession, diffQueue, forkSession, leftBehind, positionAt, queueChanged, queueLengths, reduceSession, type Session, splitSession,
} from '@squirmy/client-core'
import {
  COMMAND_TRACK_LIMIT, CommandEnvelope, DEVICE_GRACE_MS, EngineReport, QUEUE_LIMIT, SessionAttach, SessionDetach, SignalReport,
  type CommandAck, type EntryFailure, type DeviceInfo, type QueueEntry, type SessionCapability, type SessionCommand, type SessionHello, type SessionHelloAck,
  type SessionMoveAck, type SessionQueue, type SessionSnapshot, type SessionSyncAck, type SignalPath,
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
import { AUTOPLAY_BATCH, autoplayRequest } from './autoplay.js'
import { recordCollectionPlay } from './collection-plays.js'
import { entryUpdates, lookupTracks, trustSeeds } from './entries.js'
import { countUntil, followPlay, insertPlay, isCompleted, notifyPlayStart, type OpenPlay, savePlay } from './plays.js'
import { applyUndo, fresh, pushUndo, undoStepFor } from './undo.js'
import { connectedDevice, connectedDeviceIds, deviceSockets, joinDevice, leaveDevice, listDevices, seeDevice, socketDevices } from './presence.js'
import {
  createOwn, deleteStoredOwn, discardOwn, loadedOwn, loadedRecord, loadedRecords, loadRecord, persist, readOwn, recordOf, rememberCommand,
  schedulePersist, serial, type SessionRecord, sessionKey, snapshotOf, storedOwn, unloadAll,
} from './store.js'

/** A reported position this far from the computed one re-anchors the session. */
const DRIFT_THRESHOLD_MS = 1000
/**
 * On-demand entries are requested while they are current or among this many next. Fetches
 * take seconds, so a few ahead keep skips and track changes from waiting on one.
 */
const PREPARE_AHEAD = 5
/**
 * Current entries whose fetch fails for an unknown reason in a row, with none ready in
 * between, before the session pauses instead of skipping on: a server that fails every
 * fetch would otherwise run down the queue one failure at a time. A track the provider
 * does not have is not counted (it is skipped), and a known outage pauses at once.
 */
const FAILURES_BEFORE_PAUSE = 3
/**
 * Distinct songs skipped in a row as not available, with nothing delivered for the session
 * in between, before it pauses instead of skipping on. A few missing songs are normal (a
 * provider lacks some editions); a run this long more likely means a provider wrongly
 * answering that it has nothing, and skipping on would run down the queue.
 */
const UNAVAILABLE_BEFORE_PAUSE = 5
/** Own sessions a user may keep; detaching beyond this drops the one gone longest, unless all are connected. */
const MAX_DETACHED = 8
/** An own session is discarded once its device has not been seen for this long. */
const DETACHED_KEEP_MS = 7 * 24 * 60 * 60_000
const CAPABILITIES: SessionCapability[] = ['detach', 'signal', 'sleepTimer', 'queueOps', 'undo']
/** Longest a sleep timer's wait is scheduled in one go; a longer one is scheduled again when this runs out. */
const MAX_TIMER_MS = 2 ** 31 - 1

/** Schedules and cancels the grace and sleep timers. */
export type SessionTimers = { set: (callback: () => void, ms: number) => unknown; clear: (handle: unknown) => void }

const realTimers: SessionTimers = {
  set: (callback, ms) => setTimeout(callback, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}
const settings: { deviceGraceMs: number; now: () => number; timers: SessionTimers } = { deviceGraceMs: DEVICE_GRACE_MS, now: () => Date.now(), timers: realTimers }
const graceTimers = new Map<string, unknown>()
/**
 * Active devices that went away while playing, by the grace timer's key: when, and where
 * the music was then. The session's clock stops meanwhile (see `startGrace`).
 */
const awayClocks = new Map<string, { at: number; positionMs: number; entryId: string }>()
/** The scheduled end of each session's `time` sleep timer, by session key (see `armSleepTimer`). */
const sleepTimers = new Map<string, { endsAt: number; handle: unknown }>()
/** The current entry whose tracks were last looked up again, by session key (see `refreshUpcoming`). */
const refreshedFor = new Map<string, string>()
/** Work started outside the per-user queues, which shutdown waits for. */
const background = new Set<Promise<void>>()
let stopping = false
let io: RealtimeServer | null = null

/**
 * Overrides timing for tests. `deviceGraceMs`: how long an active device may be gone
 * before `deviceLost`. `now`: the session clock (server epoch milliseconds), which
 * anchors positions, answers `serverTime` in hellos and times plays. `timers`: what
 * schedules the grace period and sleep timers, so a test can fire them instead of waiting;
 * `null` restores the real ones.
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
/** The sockets of a session's room whose hello accepts `queueOps`: queue changes go to them as operations. */
const opsRoom = (record: SessionRecord) => `${sessionRoom(record)}#ops`
/** Sockets whose latest hello accepts `queueOps`. Rooms are joined by socket id, so this outlives a move. */
const opsSockets = new Set<string>()

function load(userId: string): Promise<SessionRecord> {
  return loadRecord(userId, recheck)
}

/**
 * Brings a session read from the database up to date: entries that were preparing may
 * be ready or unavailable by now, and its active device may not come back.
 */
async function recheck(record: SessionRecord): Promise<void> {
  await refreshEntries(record, entriesOf(record.session))
  const preparing = [...new Set(entriesOf(record.session).filter(entry => entry.state === 'preparing').map(entry => entry.trackId))]
  const tracks = await lookupTracks(preparing)
  for (const trackId of preparing) {
    const availability = tracks.get(trackId)?.availability ?? 'none'
    if (availability === 'server') applyServer(record, { type: 'setEntryState', trackId, state: 'ready' })
    // `none` now: a provider missed it, or none is left that could fetch it.
    else if (availability === 'none') applyFailure(record, trackId, { failure: 'unavailable' })
  }
  const active = record.session.activeDeviceId
  if (active && !connectedDevice(record.userId, active)) startGrace(record, active)
  // A timer that ran out while the server was down stops playback straight away.
  armSleepTimer(record)
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
  const signal = currentSignal(record)
  return {
    serverTime: settings.now(), snapshot: snapshotOf(record), devices: deviceList(record.userId, deviceId), capabilities: CAPABILITIES,
    ...(signal ? { signal } : {}),
  }
}

/** The session's signal path while it still describes the current entry on the active device. */
function currentSignal(record: SessionRecord): SignalPath | null {
  const { signal, session } = record
  return signal && signal.entryId === session.current?.id && signal.deviceId === session.activeDeviceId ? signal : null
}

/**
 * Puts sockets in the room of `record`'s session and takes them out of any other. Rooms
 * are local to this process, which the store assumes is the only one.
 */
function joinSessionRoom(socketIds: readonly string[], record: SessionRecord): void {
  for (const socketId of socketIds) {
    const socket = io?.of('/').sockets.get(socketId)
    if (!socket) continue
    const targets = opsSockets.has(socketId) ? [sessionRoom(record), opsRoom(record)] : [sessionRoom(record)]
    for (const joined of socket.rooms) {
      if (joined.startsWith(SESSION_ROOM) && !targets.includes(joined)) void socket.leave(joined)
    }
    void socket.join(targets)
  }
}

function entriesOf(session: Session): QueueEntry[] {
  return [...(session.current ? [session.current] : []), ...session.queue, ...session.autoplayQueue, ...session.history, ...session.playedInCycle]
}

/**
 * What a committed change touched. `base`: the queue half before it, while the queue
 * changed, with its `queueVersion`, for sending the change as operations.
 */
type Change = { queue: boolean; devices: boolean; base: { queue: SessionQueue; queueVersion: number } | null }

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
  const base = queue ? { queue: splitSession(previous).queue, queueVersion: record.queueVersion } : null
  record.version += 1
  if (queue) record.queueVersion += 1
  record.session = next
  if (next.current?.state === 'ready') {
    record.failedInARow = 0
    record.skippedTracks.clear()
  }
  const { open, closed } = followPlay(record.play, previous, next, now)
  if (open && open !== record.play) notifyPlayStart(record.userId, open)
  record.play = open
  if (closed) keepSaving(record.userId, closed)
  if (record.deviceId !== null && connectedDevice(record.userId, record.deviceId)) record.lastSeenAt = now
  schedulePersist(record, report)
  if (previous.sleepTimer !== next.sleepTimer) armSleepTimer(record)
  const devices = record.deviceId === null
    ? previous.activeDeviceId !== next.activeDeviceId
    : JSON.stringify(ownSummary(previous)) !== JSON.stringify(ownSummary(next))
  return { queue, devices, base }
}

/**
 * Schedules the end of the session's `time` sleep timer, or cancels it when the session has
 * none. The server holds the session's clock, so it enforces the timer: the session pauses
 * on time whichever device set it, and whether or not that one is still there.
 */
function armSleepTimer(record: SessionRecord): void {
  const timer = record.session.sleepTimer
  const endsAt = timer?.kind === 'time' ? timer.endsAt : null
  const armed = sleepTimers.get(record.key)
  if (armed?.endsAt === endsAt) return
  if (armed) settings.timers.clear(armed.handle)
  sleepTimers.delete(record.key)
  if (endsAt === null) return
  const wait = Math.min(MAX_TIMER_MS, Math.max(0, endsAt - settings.now()))
  sleepTimers.set(record.key, {
    endsAt,
    handle: settings.timers.set(() => {
      if (sleepTimers.get(record.key)?.endsAt !== endsAt) return
      sleepTimers.delete(record.key)
      serial(record.userId, () => {
        // Looked up again: the session may have been unloaded and loaded since.
        const latest = recordOf(record.key)
        const current = latest?.session.sleepTimer
        if (!latest || current?.kind !== 'time' || current.endsAt !== endsAt) return
        // Woken early (a long timer scheduled in parts, or a clock that moved): wait for the rest.
        if (settings.now() < endsAt) return armSleepTimer(latest)
        applyServer(latest, { type: 'endSleepTimer' })
      }).catch(report)
    }, wait),
  })
}

/** Cancels a session's sleep timer when the session leaves memory. */
function disarmSleepTimer(key: string): void {
  const armed = sleepTimers.get(key)
  if (armed) settings.timers.clear(armed.handle)
  sleepTimers.delete(key)
}

/** Writes a closed play in the background; shutdown waits for it. */
function trackBackground(task: Promise<unknown>): void {
  const pending = task.then(() => undefined).catch(report).finally(() => background.delete(pending))
  background.add(pending)
}

function keepSaving(userId: string, play: OpenPlay): void {
  trackBackground(savePlay(userId, play))
}

function closePlay(record: SessionRecord): void {
  const { play } = record
  if (!play) return
  record.play = null
  countUntil(play, record.session, settings.now())
  keepSaving(record.userId, play)
}

/**
 * Sends a committed change to the sockets in the session: the queue half first, when it
 * changed. Sockets that accept `queueOps` get it as operations on the queue before, unless
 * they would be about as large as the queue (`diffQueue`'s limits): then every socket gets
 * the whole queue, a checkpoint. The whole queue is only written out when a socket gets it.
 */
function broadcast(record: SessionRecord, change: Change): void {
  if (!io) return
  const room = sessionRoom(record)
  const { state, queue } = splitSession(record.session)
  if (change.queue) {
    const rooms = io.of('/').adapter.rooms
    const withOps = rooms.get(opsRoom(record))?.size ?? 0
    const ops = withOps && change.base ? diffQueue(change.base.queue, queue) : null
    const full = { version: record.version, queueVersion: record.queueVersion, queue }
    if (ops) {
      const { scope } = snapshotOf(record)
      io.to(opsRoom(record)).emit('session:queueOps', {
        version: record.version, queueVersion: record.queueVersion, baseQueueVersion: change.base!.queueVersion, scope: scope!, lengths: queueLengths(queue), ops,
      })
      if ((rooms.get(room)?.size ?? 0) > withOps) io.to(room).except(opsRoom(record)).emit('session:queue', full)
    } else {
      io.to(room).emit('session:queue', full)
    }
  }
  io.to(room).emit('session:state', { version: record.version, state })
  if (change.devices) emitDevices(record.userId)
}

/** Applies a server-issued command under a fresh command id and broadcasts the result. */
function applyServer(record: SessionRecord, command: AnySessionCommand, now = settings.now()): void {
  const change = commit(record, reduceSession(record.session, { command, now, commandId: newId() }), now)
  if (!change) return
  broadcast(record, change)
  afterChange(record)
}

/** Work that follows a change without holding it up: preparing on-demand entries, refilling autoplay, catching up with the catalog. */
function afterChange(record: SessionRecord): void {
  requestUpcoming(record)
  refillAutoplay(record)
  refreshUpcoming(record)
}

/**
 * Brings `entries` of the session up to date with the catalog: tracks and albums merged
 * into others since they were queued take the surviving ids, and the tracks their lengths.
 * Requests made under a merged id carry over to the new one, since acquisition answers for
 * the row it linked the file to. Run in the user's serial queue.
 */
async function refreshEntries(record: SessionRecord, entries: readonly QueueEntry[]): Promise<void> {
  if (!entries.length) return
  const { tracks, albums } = await entryUpdates(entries)
  if (!tracks.length && !albums.length) return
  for (const { trackId, id } of tracks) {
    const origin = record.requested.get(trackId)
    if (id === trackId || !origin) continue
    record.requested.delete(trackId)
    if (record.requested.get(id) !== 'play') record.requested.set(id, origin)
  }
  applyServer(record, { type: 'updateTracks', tracks, albums })
}

/**
 * Looks the current entry and the next few up again each time the current entry changes,
 * so what is playing shows the track and length the catalog has now even when its row was
 * merged after it was queued.
 */
function refreshUpcoming(record: SessionRecord): void {
  const { current, queue, autoplay, autoplayQueue } = record.session
  if (!current || refreshedFor.get(record.key) === current.id) return
  refreshedFor.set(record.key, current.id)
  const entries = [current, ...[...queue, ...(autoplay ? autoplayQueue : [])].slice(0, PREPARE_AHEAD)]
  serial(record.userId, async () => {
    if (recordOf(record.key) === record) await refreshEntries(record, entries)
  }).catch(report)
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
  if (stopping) return
  const { userId } = record
  const asks: (() => Promise<void>)[] = []
  const currentId = record.session.current?.id ?? null
  for (const [trackId, since] of record.deferred) if (since !== currentId) record.deferred.delete(trackId)
  const window = toPrepare(record.session)
  for (const { entry, origin } of window) {
    const asked = record.requested.get(entry.trackId)
    if (asked === 'play' || asked === origin || record.deferred.has(entry.trackId)) continue
    const recordingId = entry.trackId
    record.requested.set(recordingId, origin)
    const upcoming = origin === 'prefetch' ? window.flatMap((item) =>
      item.origin === 'prefetch' && item.entry.id !== entry.id ? [{ recordingId: item.entry.trackId, albumId: item.entry.albumId }] : [],
    ) : []
    const request = { userId, recordingId, albumId: entry.albumId, origin, ...(upcoming.length ? { upcoming } : {}) }
    asks.push(async () => {
      const wanted = !stopping && recordOf(record.key) === record && toPrepare(record.session).some(({ entry }) => entry.trackId === recordingId)
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
          if (latest?.requested.delete(recordingId)) applyFailure(latest, recordingId, { failure: 'error' })
        })
      }).catch(report)
    })
  }
  if (asks.length) trackBackground(asks.reduce((chain, ask) => chain.then(ask), Promise.resolve()))
}

/** Why a fetch failed, as acquisition tells it: see `EntryFailure`. `reason` goes with an outage. */
export type FetchFailure = { failure: EntryFailure; reason?: string }

/**
 * Applies a failed fetch of `trackId`. The session's sockets are told why first
 * (`playback.failed`), so clients word the notice for a skipped song. Entries further down
 * are only marked failed: the session skips them quietly when it reaches them. What
 * happens to a preparing current entry depends on why:
 *
 * - Any reason but `outage`, for the song the listener just picked (`SessionRecord.picked`):
 *   the session pauses on it, failed, without a stop notice, rather than start a song they
 *   did not pick. Clients tell it as a song that could not play.
 * - `unavailable` (the provider does not have it): skipped, and playback goes on with the
 *   next playable entry. When nothing after it is playable any more, the session stops on
 *   it, and when that ends a run of such songs it says so once (`playback.unavailable`,
 *   `exhausted`). Once `UNAVAILABLE_BEFORE_PAUSE` distinct songs have been skipped so with
 *   nothing delivered in between, it pauses on it instead, saying so once (`unavailable`).
 * - `outage` (the provider is failing or unreachable, so the next would fail too): the
 *   session pauses on it with the rest of the queue kept, and says why once. Entries
 *   further down that fail in an outage are not marked: they stay preparing, and are asked
 *   for again once the current entry changes (`deferred`).
 * - `error` (anything else): skipped, unless it is the `FAILURES_BEFORE_PAUSE`th in a row
 *   with nothing ready in between: then it pauses as for an outage, without a reason, so
 *   a broken server does not run down the queue one failure at a time.
 *
 * The stop notice goes to that session only, and before the state that stops, so a
 * client shows the stop with its reason rather than a generic notice first (see `outage`
 * in client-core's session client). Nothing more is fetched until the user plays again
 * (see `toPrepare`), and `play` moves on from the failed entry.
 */
function applyFailure(record: SessionRecord, trackId: string, { failure, reason }: FetchFailure): void {
  const { session } = record
  if (!entriesOf(session).some(entry => entry.trackId === trackId && entry.state !== 'failed')) return
  const room = io?.to(sessionRoom(record))
  room?.emit('event', { type: 'playback.failed', trackId, failure })
  const { current } = session
  const now = settings.now()
  const fail = (from: Session) => reduceSession(from, { command: { type: 'setEntryState', trackId, state: 'failed' }, now, commandId: newId() })
  if (!current || current.trackId !== trackId || current.state !== 'preparing') {
    if (failure === 'outage') {
      // The provider failed, not the track: an entry further down stays preparing, and is
      // asked for again once the current entry changes (it plays on, or the user plays
      // again after a pause), not straight away while fetching is down.
      record.deferred.set(trackId, current?.id ?? null)
      return
    }
    finish(record, fail(session), now)
    return
  }
  // The song the listener just picked: playback stays on it, paused, rather than start one
  // they did not ask for. Clients tell it as a song that could not play; Next moves on.
  if (failure !== 'outage' && record.picked === current.id) {
    stay(record, current, now)
    return
  }
  if (failure === 'error') record.failedInARow += 1
  const pause = failure === 'outage' || (failure === 'error' && record.failedInARow >= FAILURES_BEFORE_PAUSE)
  if (!pause) {
    const next = fail(session)
    if (failure === 'unavailable') {
      const rest = [...session.queue, ...(session.autoplay ? session.autoplayQueue : [])]
      // The reducer moves past this entry and the failed ones right after it in one step:
      // each is a song skipped as not available.
      const to = rest.findIndex(entry => entry.id === next.current?.id)
      for (const entry of [current, ...(to < 0 ? rest : rest.slice(0, to))]) {
        if (entry.trackId === trackId || entry.state === 'failed') record.skippedTracks.add(entry.trackId)
      }
      const stops = next.current?.id === current.id && !next.playing
      // With none playable after it, the reducer stops on this one. That ends a run of
      // songs that were not to be had (those after it failed already, or were skipped one
      // by one up to it); one song alone at the end of the queue is just skipped.
      if (stops && (rest.length > 0 || record.skippedTracks.size > 1)) {
        record.skippedTracks.clear()
        room?.emit('event', { type: 'playback.unavailable', trackId, kind: 'exhausted', reason: null })
      } else if (!stops && record.skippedTracks.size >= UNAVAILABLE_BEFORE_PAUSE) {
        // So many in a row with nothing delivered more likely means a provider that wrongly
        // says it has nothing than that none of these songs exist.
        hold(record, current, 'unavailable', null, now)
        return
      }
    }
    finish(record, next, now)
    return
  }
  hold(record, current, failure === 'outage' ? 'outage' : 'failures', reason ?? null, now)
}

/**
 * Pauses the session on its current entry, which failed, keeping the rest of the queue,
 * and tells its sockets why (`playback.unavailable`) before the state that pauses.
 */
function hold(record: SessionRecord, current: QueueEntry, kind: 'outage' | 'failures' | 'unavailable', reason: string | null, now: number): void {
  io?.to(sessionRoom(record)).emit('event', { type: 'playback.unavailable', trackId: current.trackId, kind, reason })
  finish(record, heldOn(record, current, now), now)
}

/** Pauses on the current entry, which failed, without a stop notice: see `SessionRecord.picked`. */
function stay(record: SessionRecord, current: QueueEntry, now: number): void {
  finish(record, heldOn(record, current, now), now)
}

/** The session paused on its current entry, marked failed, with the rest of the queue kept. */
function heldOn(record: SessionRecord, current: QueueEntry, now: number): Session {
  record.failedInARow = 0
  record.skippedTracks.clear()
  record.picked = null
  const paused = reduceSession(record.session, { command: { type: 'pause' }, now, commandId: newId() })
  // The reducer moves past a current entry that fails. Marked here first, the entry stays
  // current, and `setEntryState` only marks its other entries.
  const held: Session = { ...paused, current: { ...current, state: 'failed' }, positionMs: 0, anchorAt: now, stalled: false }
  const command = { type: 'setEntryState' as const, trackId: current.trackId, state: 'failed' as const }
  return reduceSession(held, { command, now, commandId: newId() })
}

/** Commits a server-made change and broadcasts it. */
function finish(record: SessionRecord, next: Session, now: number): void {
  const change = commit(record, next, now)
  if (!change) return
  broadcast(record, change)
  afterChange(record)
}

/**
 * Asks the radio module for suggestions whenever something plays with autoplay on and there
 * are none, from the start of a queue rather than its end, so a device can show what will
 * play after it (`autoplayRequest`). Asked at most once per current entry, so an empty answer
 * is not repeated. Refilling only an empty autoplay queue keeps the ids of entries a device
 * may have preloaded.
 */
function refillAutoplay(record: SessionRecord): void {
  if (stopping) return
  const { userId, session } = record
  const { current } = session
  const request = autoplayRequest(session)
  if (!request || !current || record.autoplayAskedFor === current.id) return
  record.autoplayAskedFor = current.id
  const { seeds, exclude } = request
  trackBackground(suggestAutoplay({ userId, seeds, exclude, limit: AUTOPLAY_BATCH })
    .then(tracks => serial(userId, () => {
      const latest = recordOf(record.key)
      // Only the latest ask's answer is used: one for a queue played over since would follow the new one.
      if (stopping || !tracks.length || latest !== record || latest.autoplayAskedFor !== current.id || latest.session.current?.id !== current.id
        || !latest.session.autoplay || latest.session.autoplayQueue.length) return
      applyServer(latest, { type: 'setAutoplayQueue', tracks })
    })))
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
  stopClock(record, key, lostAt)
  graceTimers.set(key, settings.timers.set(() => {
    graceTimers.delete(key)
    awayClocks.delete(key)
    serial(userId, () => {
      // Looked up again: the session may have been unloaded and loaded since.
      const latest = recordOf(record.key)
      if (!latest || connectedDevice(userId, deviceId)) return
      applyServer(latest, { type: 'deviceLost', deviceId }, Math.min(settings.now(), Math.max(lostAt, latest.session.anchorAt)))
    }).catch(report)
  }, settings.deviceGraceMs))
}

/**
 * Stops the session's clock while its active device is away: nothing says the music goes on,
 * and other devices showing it run on for the grace period and then jump back would be wrong
 * either way. Marked stalled, as for a device that is buffering, so every client, older ones
 * included, holds the position. `restartClock` undoes it when the device returns.
 */
function stopClock(record: SessionRecord, key: string, at: number): void {
  const { session } = record
  const { current } = session
  if (!current || current.state !== 'ready' || !session.playing || session.stalled) return
  const positionMs = positionAt(session, at)
  awayClocks.set(key, { at, positionMs, entryId: current.id })
  applyServer(record, { type: 'syncPosition', entryId: current.id, positionMs, stalled: true }, at)
}

/**
 * The device the clock was stopped for is back within the grace period. Most likely only
 * its connection dropped and its audio played on, so the clock is put where it would have
 * been: the device's next report corrects it, and a device that stopped (an app relaunched)
 * says so with its own commands. Nothing happens when the session changed meanwhile.
 */
function restartClock(record: SessionRecord, deviceId: string): void {
  const key = `${record.key}#${deviceId}`
  const away = awayClocks.get(key)
  if (!away) return
  awayClocks.delete(key)
  const { session } = record
  const unchanged = session.activeDeviceId === deviceId && session.playing && session.stalled
    && session.current?.id === away.entryId && session.anchorAt === away.at
  if (!unchanged) return
  const now = settings.now()
  applyServer(record, { type: 'syncPosition', entryId: away.entryId, positionMs: away.positionMs + Math.max(0, now - away.at), stalled: false }, now)
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
  disarmSleepTimer(record.key)
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
  if (hello.accepts?.includes('queueOps')) opsSockets.add(socketId)
  else opsSockets.delete(socketId)
  const returning = !connectedDevice(userId, device.id)
  joinDevice(userId, socketId, device, canPlay, settings.now())
  cancelGrace(userId, device.id)
  return serial(userId, async () => {
    await rememberDevice(db, userId, device)
    const shared = await load(userId)
    // The socket may have closed while this waited; then it joins nothing.
    if (!connectedDevice(userId, device.id)) return
    const { own, ended } = returning ? await placeReturning(userId, device.id, hello.detached) : { own: loadedOwn(userId, device.id) }
    for (const held of [shared, own]) if (held) restartClock(held, device.id)
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
  // A socket saying hello again as another device leaves first and is added back by its hello.
  opsSockets.delete(socketId)
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
      skippedTracks: new Set(shared.skippedTracks),
      deferred: new Map(shared.deferred),
      autoplayAskedFor: shared.autoplayAskedFor,
      lastSeenAt: now,
    })
    // The play goes on, now in the device's own session.
    if (wasActive && shared.play) {
      countUntil(shared.play, shared.session, now)
      own.play = shared.play
      shared.play = null
    }
    // The sleep timer goes with the device that plays on; what it leaves behind is paused.
    const change = wasActive ? commit(shared, leftBehind(shared.session, device.id, { now, commandId: newId() })) : null
    // Written at once, so a restart never finds the shared session still playing on a detached device.
    if (change) void persist(shared).catch(report)
    // A timer that came along with the device ends in its own session now.
    armSleepTimer(own)
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
    disarmSleepTimer(own.key)
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
      shared.skippedTracks = new Set(own.skippedTracks)
      shared.deferred = new Map(own.deferred)
      shared.autoplayAskedFor = own.autoplayAskedFor
      // The shared queue is replaced: its edits are no longer there to undo.
      shared.undo = []
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
 * `session:sync` from `deviceId`: the session it is in, whole, for a socket whose queue
 * operations did not apply (see "Queue diffs" in the session contract). Answered in order
 * with the session's updates, so operations after it build on the queue it carries.
 */
export function sync(userId: string, deviceId: string | null, ack: (reply: SessionSyncAck) => void): Promise<void> {
  return serial(userId, async () => {
    const device = deviceId ? connectedDevice(userId, deviceId) : undefined
    if (!device) return ack({ ok: false, error: 'hello_required' })
    ack({ ok: true, snapshot: snapshotOf(await sessionOf(userId, device.id)) })
  }).catch(error => {
    report(error)
    ack({ ok: false, error: 'internal_error' })
  })
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
    const now = settings.now()
    const next = command.type === 'undo' ? undo(record, command.commandId, now, commandId) : reduceSession(record.session, { command, now, commandId, deviceId: device.canPlay ? device.id : undefined })
    if (typeof next === 'string') return ack({ ok: false, error: next })
    rememberCommand(record, commandId)
    const step = next === record.session ? null : undoStepFor(command, commandId, record.session, next, now)
    if (step) record.undo = pushUndo(record.undo, step)
    // Something new to play starts a new count of failures, and nothing before it is undone.
    if (command.type === 'playTracks') {
      record.failedInARow = 0
      record.skippedTracks.clear()
      record.undo = []
    }
    // A song started by name (its row, or an entry of the queue) is the one the listener wants. A
    // whole list started (a header's Play, Shuffle, a radio, or a client that does not say) moves
    // on past a first song that cannot be had.
    const byName = command.type === 'playQueueEntry' || (command.type === 'playTracks' && command.startedFrom === 'song' && !command.shuffle)
    if (byName && next.current?.id !== record.session.current?.id) {
      record.picked = next.current?.id ?? null
    } else if (command.type === 'playTracks') {
      record.picked = null
    }
    // Playing again asks again for what an outage left waiting.
    if (command.type === 'play' || command.type === 'playTracks') record.deferred.clear()
    const change = commit(record, next)
    ack({ ok: true, version: record.version })
    if (!change) return
    broadcast(record, change)
    afterChange(record)
    // Starting a collection is a play of it, for the Library's Recently played.
    if (command.type === 'playTracks') trackBackground(recordCollectionPlay(userId, command.context, settings.now()))
  }).catch(error => {
    report(error)
    ack({ ok: false, error: 'internal_error' })
  })
}

/**
 * The session with the edit sent as `target` undone, taking it off the stack, or an error
 * code (see "Undo" in the session contract).
 */
function undo(record: SessionRecord, target: string, now: number, commandId: string): Session | string {
  record.undo = fresh(record.undo, now)
  const step = record.undo.find(item => item.commandId === target)
  if (!step) return 'nothing_to_undo'
  const next = applyUndo(record.session, step, now, commandId)
  // One that no longer applies is gone either way; a full queue may have room later.
  if (next !== 'queue_full') record.undo = record.undo.filter(item => item !== step)
  return next
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

/**
 * `session:signal` from `deviceId`: what it plays (see "Signal path" in the session
 * contract). Only the active device's report about the current entry is kept and passed on
 * to the sockets in the session, the sender's included.
 */
export function applySignal(userId: string, deviceId: string | null, raw: unknown): Promise<void> {
  const parsed = SignalReport.safeParse(raw)
  if (!parsed.success || !deviceId) return Promise.resolve()
  return serial(userId, () => {
    const record = loadedOwn(userId, deviceId) ?? loadedRecord(userId)
    const session = record?.session
    if (!record || !session || session.activeDeviceId !== deviceId || session.current?.id !== parsed.data.entryId) return
    const signal: SignalPath = { ...parsed.data, deviceId }
    record.signal = signal
    io?.to(sessionRoom(record)).emit('session:signal', signal)
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
    record.skippedTracks.clear()
    record.undo = []
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
  return setRecordingState(recordingId, null)
}

/**
 * Marks every entry of the recording failed in the loaded sessions, for the reason given
 * (an unknown `error` when none is). A preparing current entry is skipped or the session
 * pauses on it, as `applyFailure` says; a ready one keeps playing, and only its later plays
 * fail. Entries further down are marked quietly.
 */
export function markRecordingFailed(recordingId: string, failure: FetchFailure = { failure: 'error' }): Promise<void> {
  return setRecordingState(recordingId, failure)
}

async function setRecordingState(recordingId: string, failure: FetchFailure | null): Promise<void> {
  // The request is answered for sessions that no longer hold the recording too, so one
  // that queues it again asks again instead of waiting on an answer that already came.
  // A session that asked for a recording under an id merged since is answered under the
  // surviving one: those are looked up again first.
  await Promise.all([...loadedRecords()].filter(record => record.requested.has(recordingId) || holds(record, recordingId) || awaitsOther(record, recordingId))
    .map(({ userId, key }) => serial(userId, async () => {
      const asked = recordOf(key)
      if (asked && !holds(asked, recordingId)) await refreshEntries(asked, entriesOf(asked.session).filter(entry => asked.requested.has(entry.trackId)))
      const record = recordOf(key)
      if (!record) return
      record.requested.delete(recordingId)
      if (!holds(record, recordingId)) return
      if (failure) return applyFailure(record, recordingId, failure)
      // Something was delivered: a run of songs not to be had is over.
      record.skippedTracks.clear()
      applyServer(record, { type: 'setEntryState', trackId: recordingId, state: 'ready' })
    })))
}

/**
 * Puts the failed entries of a recording back to preparing in the loaded sessions: its
 * failure turned out to be part of a provider outage (acquisition/health.ts), so it is
 * playable after all. It is asked for again once the current entry changes or the user
 * plays again, not while fetching is still down. A current entry it held stays paused.
 */
export async function markRecordingRestored(recordingId: string): Promise<void> {
  await Promise.all([...loadedRecords()].filter(record => holds(record, recordingId))
    .map(({ userId, key }) => serial(userId, () => {
      const record = recordOf(key)
      const entries = record ? entriesOf(record.session).filter(entry => entry.trackId === recordingId) : []
      if (!record || !entries.some(entry => entry.state === 'failed') || entries.some(entry => entry.state === 'ready')) return
      record.requested.delete(recordingId)
      record.deferred.set(recordingId, record.session.current?.id ?? null)
      applyServer(record, { type: 'setEntryState', trackId: recordingId, state: 'preparing' })
    })))
}

function holds(record: SessionRecord, recordingId: string): boolean {
  return entriesOf(record.session).some(entry => entry.trackId === recordingId)
}

/** The session waits on the answer for another recording, which may be the one answered under a merged id. */
function awaitsOther(record: SessionRecord, recordingId: string): boolean {
  return [...record.requested.keys()].some(id => id !== recordingId && holds(record, id))
}

/**
 * Writes every session and the plays still open, forgets them, and cancels device timers.
 * An open play stays open in the stored session: after a restart it goes on as the same
 * row, so a listen across the restart is one play.
 */
export async function stopSessions(): Promise<void> {
  stopping = true
  try {
    await finishSessions()
  } finally {
    stopping = false
  }
}

async function finishSessions(): Promise<void> {
  for (const timer of graceTimers.values()) settings.timers.clear(timer)
  graceTimers.clear()
  for (const { handle } of sleepTimers.values()) settings.timers.clear(handle)
  sleepTimers.clear()
  awayClocks.clear()
  refreshedFor.clear()
  opsSockets.clear()
  for (const record of loadedRecords()) {
    if (record.deviceId === null || !connectedDevice(record.userId, record.deviceId)) continue
    record.lastSeenAt = settings.now()
    schedulePersist(record, report)
  }
  await unloadAll(async record => {
    const { play } = record
    if (!play) return
    countUntil(play, record.session, settings.now())
    await savePlay(record.userId, play, { closed: false }).catch(report)
  })
  while (background.size) await Promise.all(background)
}
