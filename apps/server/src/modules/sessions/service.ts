import { type AnySessionCommand, positionAt, queueChanged, reduceSession, type Session, splitSession } from '@squirmy/client-core'
import {
  CommandEnvelope, EngineReport,
  type CommandAck, type DeviceInfo, type QueueEntry, type SessionCommand, type SessionHello, type SessionHelloAck, type SessionSnapshot,
} from '@squirmy/contracts'
import { and, eq } from 'drizzle-orm'
import { getConfig } from '../../config.js'
import { db } from '../../database/client.js'
import { devices } from '../../database/schema.js'
import { newId } from '../../lib/ids.js'
import type { RealtimeServer } from '../../realtime/index.js'
import { requestRecording } from '../acquisition/coverage.js'
import { suggestAutoplay } from '../radio/suggest.js'
import { lookupTracks, trustSeeds } from './entries.js'
import { countUntil, followPlay, insertPlay, isCompleted, notifyPlayStart, savePlay } from './plays.js'
import { connectedDevice, joinDevice, leaveDevice, listDevices } from './presence.js'
import {
  loadedRecord, loadedRecords, loadRecord, rememberCommand, schedulePersist, serial, type SessionRecord, snapshotOf, unloadAll,
} from './store.js'

/** A reported position this far from the computed one re-anchors the session. */
const DRIFT_THRESHOLD_MS = 1000
/** Autoplay is refilled when fewer entries than this are left in the queue. */
const AUTOPLAY_LOW_WATER = 3
const AUTOPLAY_BATCH = 10
const AUTOPLAY_SEEDS = 10
/** On-demand entries are requested while they are current or among this many next. */
const PREPARE_AHEAD = 2

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

const room = (userId: string) => `user:${userId}`

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
    if (availability !== 'on_demand') applyServer(record, { type: 'setEntryState', trackId, state: availability === 'server' ? 'ready' : 'failed' })
  }
  const active = record.session.activeDeviceId
  if (active && !connectedDevice(record.userId, active)) startGrace(record.userId, active)
  afterChange(record)
}

function entriesOf(session: Session): QueueEntry[] {
  return [...(session.current ? [session.current] : []), ...session.queue, ...session.autoplayQueue, ...session.history, ...session.playedInCycle]
}

type Change = { queue: boolean; devices: boolean }

/** Makes `next` the session: bumps versions, follows the open play and schedules a write. Null when nothing changed. */
function commit(record: SessionRecord, next: Session): Change | null {
  const previous = record.session
  if (next === previous) return null
  const queue = queueChanged(previous, next)
  record.version += 1
  if (queue) record.queueVersion += 1
  record.session = next
  const { open, closed } = followPlay(record.play, previous, next, settings.now())
  if (open && open !== record.play) notifyPlayStart(record.userId, open)
  record.play = open
  if (closed) {
    const saving = savePlay(record.userId, closed).catch(report).finally(() => savingPlays.delete(saving))
    savingPlays.add(saving)
  }
  schedulePersist(record, report)
  return { queue, devices: previous.activeDeviceId !== next.activeDeviceId }
}

/** Sends a committed change to every socket of the user: the queue half first, when it changed. */
function broadcast(record: SessionRecord, change: Change): void {
  if (!io) return
  const target = io.to(room(record.userId))
  const { state, queue } = splitSession(record.session)
  if (change.queue) target.emit('session:queue', { version: record.version, queueVersion: record.queueVersion, queue })
  target.emit('session:state', { version: record.version, state })
  if (change.devices) target.emit('devices', listDevices(record.userId, record.session.activeDeviceId))
}

/** Applies a server-issued command under a fresh command id and broadcasts the result. */
function applyServer(record: SessionRecord, command: AnySessionCommand, now = settings.now()): void {
  const change = commit(record, reduceSession(record.session, { command, now, commandId: newId() }))
  if (!change) return
  broadcast(record, change)
  afterChange(record)
}

/** Work that follows a change without holding it up: preparing on-demand entries and refilling autoplay. */
function afterChange(record: SessionRecord): void {
  requestUpcoming(record)
  refillAutoplay(record)
}

function requestUpcoming(record: SessionRecord): void {
  const { current, queue, autoplay, autoplayQueue } = record.session
  const upcoming = [...queue, ...(autoplay ? autoplayQueue : [])].slice(0, PREPARE_AHEAD)
  for (const entry of current ? [current, ...upcoming] : upcoming) {
    if (entry.state !== 'preparing' || record.requested.has(entry.trackId)) continue
    const { userId } = record
    const recordingId = entry.trackId
    record.requested.add(recordingId)
    requestRecording({ userId, recordingId, albumId: entry.albumId }).catch((error: unknown) => {
      report(error)
      // A request that threw was never made, so no outcome will come: fail the entries
      // rather than leave them preparing. A job that did start still marks them ready.
      return serial(userId, () => {
        const latest = loadedRecord(userId)
        if (latest?.requested.delete(recordingId)) applyServer(latest, { type: 'setEntryState', trackId: recordingId, state: 'failed' })
      })
    }).catch(report)
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
      const latest = loadedRecord(userId)
      if (!tracks.length || latest !== record || !latest.session.autoplay || latest.session.autoplayQueue.length) return
      applyServer(latest, { type: 'setAutoplayQueue', tracks })
    }))
    .catch(report)
}

function startGrace(userId: string, deviceId: string): void {
  const key = `${userId}:${deviceId}`
  if (graceTimers.has(key)) return
  graceTimers.set(key, settings.timers.set(() => {
    graceTimers.delete(key)
    serial(userId, () => {
      const record = loadedRecord(userId)
      if (record && !connectedDevice(userId, deviceId)) applyServer(record, { type: 'deviceLost', deviceId })
    }).catch(report)
  }, settings.deviceGraceMs))
}

function cancelGrace(userId: string, deviceId: string): void {
  const key = `${userId}:${deviceId}`
  if (graceTimers.has(key)) settings.timers.clear(graceTimers.get(key))
  graceTimers.delete(key)
}

// Socket protocol

/**
 * `session:hello`: records the device as connected (and in `devices`), then calls `reply`
 * with the snapshot and device list, in order with the session's other updates.
 */
export function greet(userId: string, socketId: string, hello: SessionHello, reply: (ack: SessionHelloAck) => void): Promise<void> {
  const { device, canPlay } = hello
  joinDevice(userId, socketId, device, canPlay)
  cancelGrace(userId, device.id)
  return serial(userId, async () => {
    await db.insert(devices).values({ userId, id: device.id, name: device.name, kind: device.kind })
      .onConflictDoUpdate({ target: [devices.userId, devices.id], set: { name: device.name, kind: device.kind, lastSeenAt: new Date() } })
    const record = await load(userId)
    reply({ serverTime: settings.now(), snapshot: snapshotOf(record), devices: listDevices(userId, record.session.activeDeviceId) })
  }).catch(report)
}

/**
 * A socket of the device closed. When it was the device's last one, the other sockets
 * get the new device list, and an active device gets the grace period to come back.
 */
export function leave(userId: string, socketId: string, deviceId: string): void {
  if (!leaveDevice(userId, socketId, deviceId)) return
  serial(userId, () => {
    const record = loadedRecord(userId)
    io?.to(room(userId)).emit('devices', listDevices(userId, record?.session.activeDeviceId ?? null))
    if (record?.session.activeDeviceId === deviceId && !connectedDevice(userId, deviceId)) startGrace(userId, deviceId)
  }).catch(report)
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
    const record = await load(userId)
    if (record.commandIds.has(commandId)) return ack({ ok: true, version: record.version })
    const device = deviceId ? connectedDevice(userId, deviceId) : undefined
    if (!device) return ack({ ok: false, error: 'hello_required' })
    const command = await checkCommand(record, device.id, envelope.data.command)
    if (typeof command === 'string') return ack({ ok: false, error: command })
    const next = reduceSession(record.session, { command, now: settings.now(), commandId, deviceId: device.canPlay ? device.id : undefined })
    rememberCommand(record, commandId)
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
    case 'transfer':
      return connectedDevice(userId, command.deviceId)?.canPlay ? command : 'device_unavailable'
    case 'setVolume':
      return await isKnownDevice(userId, command.deviceId) ? command : 'unknown_device'
    case 'playTracks': {
      const { seeds, indexes } = await trustSeeds(command.tracks)
      if (!seeds.length) return 'nothing_playable'
      if (command.startIndex === undefined) return { ...command, tracks: seeds }
      // A start track that was dropped gives way to the next playable one, else the first.
      const startIndex = Math.max(0, indexes.findIndex(index => index >= command.startIndex!))
      return { ...command, tracks: seeds, startIndex }
    }
    case 'enqueue': {
      const { seeds } = await trustSeeds(command.tracks)
      return seeds.length ? { ...command, tracks: seeds } : 'nothing_playable'
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
    const record = loadedRecord(userId)
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

/** The user's session as `GET /me/session` and Subsonic's `getPlayQueue` see it. */
export function getSnapshot(userId: string): Promise<SessionSnapshot> {
  return serial(userId, async () => snapshotOf(await load(userId)))
}

/** The user's connected devices. */
export function getDevices(userId: string): Promise<DeviceInfo[]> {
  return serial(userId, async () => listDevices(userId, (await load(userId)).session.activeDeviceId))
}

/**
 * Replaces the queue with `trackIds`, paused at `currentId` (default the first) and
 * `positionMs`, for Subsonic's `savePlayQueue`. Tracks that cannot be played are dropped;
 * with none left the queue is cleared. The active device stays as it is.
 */
export function replaceQueue(userId: string, request: { trackIds: readonly string[]; currentId?: string | null; positionMs?: number }): Promise<SessionSnapshot> {
  return serial(userId, async () => {
    const record = await load(userId)
    const requested = request.trackIds.map(trackId => ({ trackId, durationMs: 0 }))
    const { seeds, indexes } = requested.length ? await trustSeeds(requested) : { seeds: [], indexes: [] }
    const start = Math.max(0, indexes.findIndex(index => request.trackIds[index] === request.currentId))
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
 * entry is skipped; a ready one keeps playing, and only its later plays fail.
 */
export function markRecordingFailed(recordingId: string): Promise<void> {
  return setRecordingState(recordingId, 'failed')
}

async function setRecordingState(recordingId: string, state: 'ready' | 'failed'): Promise<void> {
  // The request is answered for sessions that no longer hold the recording too, so one
  // that queues it again asks again instead of waiting on an answer that already came.
  await Promise.all([...loadedRecords()].filter(record => record.requested.has(recordingId) || holds(record, recordingId))
    .map(({ userId }) => serial(userId, () => {
      const record = loadedRecord(userId)
      if (!record) return
      record.requested.delete(recordingId)
      if (holds(record, recordingId)) applyServer(record, { type: 'setEntryState', trackId: recordingId, state })
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
  await unloadAll(async record => {
    const { play } = record
    if (!play) return
    countUntil(play, record.session, settings.now())
    await savePlay(record.userId, play).catch(report)
  })
  await Promise.all(savingPlays)
}
