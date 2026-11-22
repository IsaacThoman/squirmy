import type { AddressInfo } from 'node:net'
import { positionAt } from '@squirmy/client-core'
import {
  COMMAND_TRACK_LIMIT, QUEUE_LIMIT,
  type ClientToServerEvents, type CommandAck, type QueueSeed, type ServerToClientEvents, type SessionCommand, type SessionHelloAck,
  type ServerEvent, type SessionQueue, type SessionState,
} from '@squirmy/contracts'
import { eq, sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { io as connect, type Socket } from 'socket.io-client'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildApp } from '../../app.js'
import { db } from '../../database/client.js'
import { albums, devices, mediaFiles, playbackSessions, plays, recordings } from '../../database/schema.js'
import { newId } from '../../lib/ids.js'
import { matchKey } from '../../lib/text.js'
import { startRealtime } from '../../realtime/index.js'
import { useTestDatabase } from '../../test/database.js'
import { createAlbum, createLibraryRoot, createUser } from '../../test/factories.js'
import { requestRecording } from '../acquisition/coverage.js'
import { createSession } from '../auth/service.js'
import { mergeRecording } from '../matching/merge.js'
import { suggestAutoplay } from '../radio/suggest.js'
import { onPlayStart, sessionsModule } from './index.js'
import { configureSessions, getSnapshot, markRecordingFailed, markRecordingReady, recordExternalPlay, replaceQueue } from './service.js'

const onDemand = vi.hoisted(() => new Set<string>())
vi.mock('../acquisition/coverage.js', () => ({
  onDemandRecordings: vi.fn(async (ids: readonly string[]) => new Set(ids.filter((id) => onDemand.has(id)))),
  requestRecording: vi.fn(async () => {}),
}))
vi.mock('../radio/suggest.js', () => ({ suggestAutoplay: vi.fn(async () => []) }))

type Client = Socket<ServerToClientEvents, ClientToServerEvents>

/** Polls in real time until `check` passes. Unlike `expect.poll`, it never advances a fake clock. */
async function eventually<T>(read: () => T | Promise<T>, check: (value: T) => void, timeoutMs = 5000): Promise<void> {
  const deadline = performance.now() + timeoutMs
  for (;;) {
    const value = await read()
    try {
      check(value)
      return
    } catch (error) {
      if (performance.now() > deadline) throw error
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

/** Grace timers that fire only when told to. */
function manualTimers() {
  const pending = new Map<number, () => void>()
  let serial = 0
  configureSessions({
    timers: {
      set: (callback) => {
        pending.set(++serial, callback)
        return serial
      },
      clear: (handle) => void pending.delete(handle as number),
    },
  })
  return {
    pending: () => pending.size,
    fireAll: () => {
      for (const [handle, callback] of [...pending]) {
        pending.delete(handle)
        callback()
      }
    },
  }
}

/** A session clock that moves only when told to. */
function stoppedClock() {
  let time = Date.now()
  configureSessions({ now: () => time })
  return { now: () => time, advance: (ms: number) => void (time += ms) }
}

type Logged = [event: string, payload: unknown]

/** A raw socket.io client that logs every session event and every ack, in arrival order. */
class Peer {
  readonly log: Logged[] = []
  private serial = 0

  constructor(readonly socket: Client, readonly deviceId: string) {
    for (const event of ['session:state', 'session:queue', 'devices', 'invalidate', 'event'] as const) {
      socket.on(event, (payload: unknown) => this.log.push([event, payload]))
    }
  }

  hello(canPlay = true): Promise<SessionHelloAck> {
    return this.socket.emitWithAck('session:hello', { device: { id: this.deviceId, name: `Device ${this.deviceId}`, kind: 'web' }, canPlay })
  }

  /** Sends a command; the ack is logged from the socket.io callback, in order with events. */
  send(command: SessionCommand, commandId = `${this.deviceId}-${++this.serial}`): Promise<CommandAck> {
    return new Promise((resolve) => {
      this.socket.emit('session:command', { commandId, command }, (ack) => {
        this.log.push(['ack', ack])
        resolve(ack)
      })
    })
  }

  events(name: string): unknown[] {
    return this.log.filter(([event]) => event === name).map(([, payload]) => payload)
  }

  /** Waits for the `session:state` of `version` and returns it. */
  async state(version: number): Promise<SessionState> {
    await eventually(() => this.states().map((update) => update.version), (versions) => expect(versions).toContain(version))
    return this.states().find((update) => update.version === version)!.state
  }

  states(): { version: number; state: SessionState }[] {
    return this.events('session:state') as { version: number; state: SessionState }[]
  }

  queues(): { version: number; queueVersion: number; queue: SessionQueue }[] {
    return this.events('session:queue') as { version: number; queueVersion: number; queue: SessionQueue }[]
  }

  lastDevices(): { id: string; isActive: boolean }[] {
    return this.events('devices').at(-1) as { id: string; isActive: boolean }[]
  }
}

describe('sessions', () => {
  useTestDatabase()
  let app: FastifyInstance
  let url = ''
  const sockets: Client[] = []
  let album: Awaited<ReturnType<typeof createAlbum>>
  let user: { id: string; token: string }

  beforeAll(async () => {
    app = await buildApp()
    await sessionsModule.realtime!(await startRealtime(app))
    await app.listen({ host: '127.0.0.1', port: 0 })
    url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`
    album = await createAlbum({ owned: true })
  })
  beforeEach(async () => {
    configureSessions({ deviceGraceMs: 20_000, now: () => Date.now(), timers: null })
    vi.mocked(requestRecording).mockClear()
    vi.mocked(suggestAutoplay).mockReset().mockResolvedValue([])
    onDemand.clear()
    // May have tracks fetched, so on-demand tracks are kept in its queues.
    user = await newUser({ canAcquire: true })
  })
  afterEach(async () => {
    for (const socket of sockets.splice(0)) socket.disconnect()
    await sessionsModule.stop!()
  })
  afterAll(async () => {
    await app.close()
  })

  async function newUser(input: Parameters<typeof createUser>[0] = {}) {
    const row = await createUser(input)
    const { token } = await createSession(db, { userId: row.id, clientKind: 'test' })
    return { id: row.id, token }
  }

  async function open(deviceId: string, token = user.token): Promise<Peer> {
    const socket: Client = connect(url, { path: '/socket.io', transports: ['websocket'], reconnection: false, auth: { token } })
    sockets.push(socket)
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve)
      socket.once('connect_error', reject)
    })
    return new Peer(socket, deviceId)
  }

  async function device(deviceId: string, options: { canPlay?: boolean; token?: string } = {}): Promise<Peer> {
    const peer = await open(deviceId, options.token)
    await peer.hello(options.canPlay ?? true)
    return peer
  }

  const seeds = (tracks = album.tracks): QueueSeed[] => tracks.map((track) => ({ trackId: track.recordingId, albumId: album.albumId, durationMs: 1 }))
  const playAlbum = (startIndex?: number): SessionCommand => ({ type: 'playTracks', tracks: seeds(), startIndex, seed: 1, context: { type: 'album', id: album.albumId, title: album.title } })
  const get = (path: string, token = user.token) => app.inject({ method: 'GET', url: `/api/v1${path}`, headers: { authorization: `Bearer ${token}` } })

  it('answers hello with the server time, the snapshot and the connected devices', async () => {
    const a = await open('device-a-0001')
    const before = Date.now()
    const reply = await a.hello()
    expect(reply.serverTime).toBeGreaterThanOrEqual(before)
    expect(reply.snapshot).toMatchObject({ version: 0, queueVersion: 0, state: { current: null, playing: false, activeDeviceId: null }, queue: { queue: [] } })
    expect(reply.devices).toEqual([{ id: 'device-a-0001', name: 'Device device-a-0001', kind: 'web', canPlay: true, isActive: false, isCurrent: true, lastSeenAt: expect.any(Number) }])
    expect(reply.devices[0]!.lastSeenAt).toBeGreaterThanOrEqual(before)

    const b = await open('device-b-0001')
    const second = await b.hello(false)
    expect(second.devices.map((item) => [item.id, item.isCurrent])).toEqual([['device-a-0001', false], ['device-b-0001', true]])
    // Each socket gets the list as its own device sees it.
    await eventually(() => a.lastDevices()?.map((item) => item.id), (value) => expect(value).toEqual(['device-a-0001', 'device-b-0001']))
    expect(a.events('devices').at(-1)).toEqual(second.devices.map((item) => ({ ...item, isCurrent: item.id === 'device-a-0001' })))
    expect(b.events('devices')).toEqual([])
    expect(await db.select({ id: devices.id }).from(devices).where(eq(devices.userId, user.id))).toHaveLength(2)

    // Over HTTP, the current device is the one the sign-in was made from; this one named none.
    const unnamed = second.devices.map((item) => ({ ...item, isCurrent: false }))
    expect((await get('/me/devices')).json()).toEqual({ items: unnamed, nextCursor: null })
    const { token } = await createSession(db, { userId: user.id, clientKind: 'test', device: { id: 'device-b-0001', name: 'Device device-b-0001', kind: 'web' } })
    expect((await get('/me/devices', token)).json()).toEqual({ items: second.devices, nextCursor: null })
    expect((await get('/me/session')).json()).toEqual(second.snapshot)
    expect((await app.inject({ method: 'GET', url: '/api/v1/me/session' })).statusCode).toBe(401)
    expect((await app.inject({ method: 'GET', url: '/api/v1/me/devices' })).statusCode).toBe(401)

    b.socket.disconnect()
    await eventually(() => a.lastDevices()?.map((item) => item.id), (value) => expect(value).toEqual(['device-a-0001']))
  })

  it('says when each device was last seen, sending the list again once a minute has passed', async () => {
    const clock = stoppedClock()
    const a = await device('device-a-0003')
    const b = await device('device-b-0003', { canPlay: false })
    const seen = (peer: Peer) => Object.fromEntries((peer.events('devices').at(-1) as { id: string; lastSeenAt: number }[]).map((item) => [item.id, item.lastSeenAt]))
    await eventually(() => a.events('devices').length, (count) => expect(count).toBe(1))
    const start = clock.now()
    expect(seen(a)).toEqual({ 'device-a-0003': start, 'device-b-0003': start })

    // Within the minute, a command moves the time on without sending the list.
    clock.advance(30_000)
    expect(await b.send({ type: 'setShuffle', value: true, seed: 1 })).toMatchObject({ ok: true })
    expect(b.events('devices')).toEqual([])
    clock.advance(30_000)
    expect(await b.send({ type: 'setShuffle', value: false, seed: 1 })).toMatchObject({ ok: true })
    await eventually(() => seen(a)['device-b-0003'], (value) => expect(value).toBe(start + 60_000))
    expect(seen(a)['device-a-0003']).toBe(start)
    expect((await get('/me/devices')).json().items.map((item: { lastSeenAt: number }) => item.lastSeenAt)).toEqual([start, start + 60_000])
  })

  it('acks before it broadcasts, sends the queue just before the state of the same version, and versions both halves', async () => {
    const a = await device('device-a-0002')
    const b = await device('device-b-0002')

    expect(await a.send(playAlbum(), 'play-1')).toEqual({ ok: true, version: 1 })
    const state = await a.state(1)
    // The four arrive in order on one socket, but not necessarily in one read: wait for the
    // last of them before checking the order.
    const fromAck = () => a.log.slice(a.log.findIndex(([event]) => event === 'ack')).map(([event, payload]) => ({ event, payload }))
    await eventually(() => fromAck().map(({ event }) => event), (events) => expect(events).toContain('devices'))
    expect(fromAck().map(({ event }) => event)).toEqual(['ack', 'session:queue', 'session:state', 'devices'])
    expect(fromAck()[1]!.payload).toMatchObject({ version: 1, queueVersion: 1 })
    expect(state).toMatchObject({ playing: true, activeDeviceId: 'device-a-0002', current: { id: 'play-1.0', trackId: album.tracks[0]!.recordingId } })
    expect(a.lastDevices().find((item) => item.isActive)?.id).toBe('device-a-0002')

    await b.state(1)
    expect(b.queues().map((update) => update.version)).toEqual([1])
    expect(b.queues()[0]!.queue.queue.map((entry) => entry.id)).toEqual(['play-1.1', 'play-1.2'])

    expect(await b.send({ type: 'pause' })).toEqual({ ok: true, version: 2 })
    expect(await a.state(2)).toMatchObject({ playing: false })
    expect(a.queues()).toHaveLength(1)
    expect((await get('/me/session')).json()).toMatchObject({ version: 2, queueVersion: 1 })

    expect(await b.send({ type: 'enqueue', tracks: seeds().slice(0, 1), placement: 'last' }, 'add-1')).toEqual({ ok: true, version: 3 })
    await a.state(3)
    expect(a.queues().at(-1)).toMatchObject({ version: 3, queueVersion: 2 })
  })

  it('acks duplicate command ids and no-op commands with the current version without broadcasting', async () => {
    const a = await device('device-a-0003')
    await a.send(playAlbum(), 'once')
    await a.state(1)
    expect(await a.send(playAlbum(), 'once')).toEqual({ ok: true, version: 1 })
    expect(await a.send({ type: 'setRepeat', value: 'off' })).toEqual({ ok: true, version: 1 })
    expect(await a.send({ type: 'pause' })).toEqual({ ok: true, version: 2 })
    await a.state(2)
    expect(a.states().map((update) => update.version)).toEqual([1, 2])
    expect((await getSnapshot(user.id)).state.current?.id).toBe('once.0')
  })

  it('still knows the command ids of a stored session after a restart', async () => {
    const a = await device('device-a-0022')
    await a.send(playAlbum(), 'first')
    expect(await a.send({ type: 'enqueue', tracks: seeds().slice(0, 1), placement: 'last' }, 'added')).toEqual({ ok: true, version: 2 })
    await sessionsModule.stop!()
    // A client re-sends what it has no confirmed state for after reconnecting.
    expect(await a.send({ type: 'enqueue', tracks: seeds().slice(0, 1), placement: 'last' }, 'added')).toEqual({ ok: true, version: 2 })
    expect((await getSnapshot(user.id)).queue.queue.map((entry) => entry.id)).toEqual(['first.1', 'first.2', 'added.0'])
  })

  it('enforces who may send which command', async () => {
    const stranger = await open('device-x-0004')
    expect(await stranger.send({ type: 'play' })).toEqual({ ok: false, error: 'hello_required' })
    expect(await new Promise((resolve) => stranger.socket.emit('session:command', { commandId: '', command: { type: 'play' } }, resolve)))
      .toEqual({ ok: false, error: 'invalid_command' })

    const a = await device('device-a-0004')
    const b = await device('device-b-0004')
    const remote = await device('remote-0004', { canPlay: false })
    await a.send(playAlbum(), 'start')
    await a.state(1)

    expect(await b.send({ type: 'trackEnded', entryId: 'start.0' })).toEqual({ ok: false, error: 'not_active_device' })
    expect(await b.send({ type: 'transfer', deviceId: 'remote-0004' })).toEqual({ ok: false, error: 'device_unavailable' })
    expect(await b.send({ type: 'transfer', deviceId: 'nowhere-0004' })).toEqual({ ok: false, error: 'device_unavailable' })
    expect(await b.send({ type: 'setVolume', deviceId: 'nowhere-0004', value: 0.5 })).toEqual({ ok: false, error: 'unknown_device' })
    await db.insert(devices).values({ userId: user.id, id: 'offline-0004', name: 'Offline' })
    expect(await b.send({ type: 'setVolume', deviceId: 'offline-0004', value: 0.5 })).toEqual({ ok: true, version: 2 })

    // A remote that cannot play never becomes the active device.
    await a.send({ type: 'transfer', deviceId: 'device-b-0004', play: false })
    expect((await remote.state(3)).activeDeviceId).toBe('device-b-0004')
    await remote.send({ type: 'playTracks', tracks: seeds(), seed: 1 })
    expect((await remote.state(4)).activeDeviceId).toBe('device-b-0004')

    expect(await a.send({ type: 'trackEnded', entryId: 'start.0' })).toEqual({ ok: false, error: 'not_active_device' })
  })

  it('transfers playback, keeping the position', async () => {
    const clock = stoppedClock()
    const a = await device('device-a-0005')
    const b = await device('device-b-0005')
    await a.send(playAlbum())
    await b.state(1)
    clock.advance(42_000)
    expect(await b.send({ type: 'transfer', deviceId: 'device-b-0005' })).toEqual({ ok: true, version: 2 })
    expect(await a.state(2)).toMatchObject({ activeDeviceId: 'device-b-0005', playing: true, positionMs: 42_000, anchorAt: clock.now() })
    await eventually(() => a.lastDevices().find((item) => item.isActive)?.id, (value) => expect(value).toBe('device-b-0005'))
  })

  it('applies deviceLost when the active device does not return within the grace period', async () => {
    const clock = stoppedClock()
    configureSessions({ deviceGraceMs: 100 })
    const a = await device('device-a-0006')
    const b = await device('device-b-0006')
    await a.send(playAlbum())
    await b.state(1)
    clock.advance(10_000)
    a.socket.disconnect()
    await eventually(() => b.lastDevices().map((item) => item.id), (value) => expect(value).toEqual(['device-b-0006']))
    expect(await b.state(3)).toMatchObject({ activeDeviceId: null, playing: false, stalled: false, positionMs: 10_000 })
  })

  it('stops the clock the moment the active device goes away, so the others hold its position', async () => {
    const clock = stoppedClock()
    const timers = manualTimers()
    const a = await device('device-a-0030')
    const b = await device('device-b-0030')
    await a.send(playAlbum())
    await b.state(1)
    clock.advance(9_000)
    a.socket.disconnect()
    const away = await b.state(2)
    expect(away).toMatchObject({ activeDeviceId: 'device-a-0030', playing: true, stalled: true, positionMs: 9_000, anchorAt: clock.now() })
    clock.advance(20_000)
    expect(positionAt(away, clock.now())).toBe(9_000)
    timers.fireAll()
    // Paused where the clock stopped: nothing jumps back.
    expect(await b.state(3)).toMatchObject({ activeDeviceId: null, playing: false, stalled: false, positionMs: 9_000 })
  })

  it('pauses a lost device where it was when it went away, and counts no play time after', async () => {
    const clock = stoppedClock()
    const timers = manualTimers()
    const a = await device('device-a-0023')
    const b = await device('device-b-0023')
    await a.send(playAlbum())
    await b.state(1)
    clock.advance(10_000)
    a.socket.disconnect()
    await eventually(() => b.lastDevices().map((item) => item.id), (value) => expect(value).toEqual(['device-b-0023']))
    clock.advance(20_000)
    timers.fireAll()
    expect(await b.state(3)).toMatchObject({ activeDeviceId: null, playing: false, positionMs: 10_000 })
    // The paused play is still open; shutdown writes it as counted so far.
    await sessionsModule.stop!()
    expect(await db.select({ msPlayed: plays.msPlayed }).from(plays).where(eq(plays.userId, user.id))).toEqual([{ msPlayed: 10_000 }])
  })

  it('keeps the active device when it reconnects within the grace period, its clock going on from where it would be', async () => {
    // However slow the reconnect, the grace period only ends when the test says so.
    const timers = manualTimers()
    const clock = stoppedClock()
    const a = await device('device-a-0007')
    const b = await device('device-b-0007')
    await a.send(playAlbum())
    await b.state(1)
    clock.advance(5_000)
    a.socket.disconnect()
    await eventually(() => b.lastDevices()?.map((item) => item.id), (value) => expect(value).toEqual(['device-b-0007']))
    expect(await b.state(2)).toMatchObject({ stalled: true, positionMs: 5_000 })
    expect(timers.pending()).toBe(1)
    clock.advance(3_000)
    const back = await open('device-a-0007')
    const hello = await back.hello()
    expect(timers.pending()).toBe(0)
    timers.fireAll()
    // Most likely only the connection dropped and the music played on.
    expect(hello.snapshot.state).toMatchObject({ activeDeviceId: 'device-a-0007', playing: true, stalled: false, positionMs: 8_000, anchorAt: clock.now() })
    expect(await b.state(3)).toEqual(hello.snapshot.state)
    expect(b.states().map((update) => update.version)).toEqual([1, 2, 3])
  })

  it('never shows one user the session of another', async () => {
    const other = await newUser()
    const mine = await device('device-a-0008')
    const theirs = await device('device-a-0008', { token: other.token })
    await mine.send(playAlbum())
    await mine.state(1)
    expect(await theirs.send({ type: 'setRepeat', value: 'all' })).toEqual({ ok: true, version: 1 })
    await theirs.state(1)
    expect(mine.states()).toHaveLength(1)
    expect(theirs.states()).toHaveLength(1)
    expect(theirs.states()[0]!.state).toMatchObject({ current: null, repeat: 'all' })
    expect(theirs.lastDevices()).toBeUndefined()
    expect((await getSnapshot(user.id)).state.repeat).toBe('off')
  })

  it('persists sessions, reloads them, and starts fresh from a corrupt stored session', async () => {
    const a = await device('device-a-0009')
    await a.send(playAlbum(1))
    await a.send({ type: 'setRepeat', value: 'one' })
    await a.state(2)
    // Written about a second after the change, without waiting for shutdown. The rest of
    // the deadline is slack for a loaded database; a write that never comes still fails.
    await eventually(async () => (await db.select().from(playbackSessions).where(eq(playbackSessions.userId, user.id)))[0]?.version, (value) => expect(value).toBe(2), 10_000)
    const before = await getSnapshot(user.id)

    await sessionsModule.stop!()
    expect(await getSnapshot(user.id)).toEqual(before)

    await a.send({ type: 'pause' })
    await sessionsModule.stop!()
    const [row] = await db.select().from(playbackSessions).where(eq(playbackSessions.userId, user.id))
    expect(row).toMatchObject({ version: 3, queueVersion: 1 })

    await db.update(playbackSessions).set({ state: { state: { current: 'not an entry' }, queue: [] } }).where(eq(playbackSessions.userId, user.id))
    const reloaded = await getSnapshot(user.id)
    expect(reloaded.state).toMatchObject({ current: null, playing: false, repeat: 'off' })
    expect(reloaded.version).toBe(3)
  })

  it('starts the grace period for an active device that is not connected when a session loads', async () => {
    configureSessions({ deviceGraceMs: 100 })
    const a = await device('device-a-0010')
    await a.send(playAlbum())
    await a.state(1)
    a.socket.disconnect()
    await sessionsModule.stop!()
    const b = await device('device-b-0010')
    // Whether the clock stopped first depends on when the disconnect was handled.
    await eventually(() => b.states().at(-1)?.state, (state) => expect(state).toMatchObject({ activeDeviceId: null, playing: false, stalled: false }))
  })

  it('takes durations from the database and drops tracks that cannot be played', async () => {
    const partial = await createAlbum({ owned: [0, 2], tracks: [{ title: 'One', durationMs: 100_000 }, { title: 'Two' }, { title: 'Three', durationMs: 300_000 }] })
    const merged = newId()
    await db.insert(recordings).values({ id: merged, title: 'Old', artistCredit: 'x', titleKey: matchKey('Old'), matchKey: 'x|old', mergedIntoId: partial.tracks[0]!.recordingId })
    const a = await device('device-a-0011')
    const tracks: QueueSeed[] = [
      { trackId: newId(), durationMs: 5 },
      { trackId: partial.tracks[1]!.recordingId, albumId: partial.albumId, durationMs: 5 },
      { trackId: partial.tracks[2]!.recordingId, albumId: partial.albumId, durationMs: 5, state: 'preparing' },
      { trackId: merged, albumId: newId(), durationMs: 5 },
    ]
    expect(await a.send({ type: 'playTracks', tracks, startIndex: 1, seed: 1 }, 'checked')).toEqual({ ok: true, version: 1 })
    expect((await a.state(1)).current).toEqual({ id: 'checked.0', trackId: partial.tracks[2]!.recordingId, albumId: partial.albumId, durationMs: 300_000, state: 'ready' })
    expect(a.queues()[0]!.queue.queue).toEqual([{ id: 'checked.1', trackId: partial.tracks[0]!.recordingId, albumId: null, durationMs: 100_000, state: 'ready' }])

    expect(await a.send({ type: 'enqueue', tracks: tracks.slice(0, 2), placement: 'next' })).toEqual({ ok: false, error: 'nothing_playable' })
    expect(await a.send({ type: 'playTracks', tracks: tracks.slice(0, 2), seed: 1 })).toEqual({ ok: false, error: 'nothing_playable' })
  })

  it('refuses to grow the queue past QUEUE_LIMIT, counting the tracks it trusts', async () => {
    const a = await device('device-a-0019')
    const many = (count: number) => Array.from({ length: count }, (_, index) => seeds()[index % album.tracks.length]!)
    await a.send(playAlbum())
    expect(await a.send({ type: 'enqueue', tracks: many(COMMAND_TRACK_LIMIT), placement: 'last' })).toMatchObject({ ok: true })
    // Unplayable tracks are dropped before counting, so this one fits exactly.
    const room = QUEUE_LIMIT - (album.tracks.length - 1) - COMMAND_TRACK_LIMIT
    const fits = [...many(room), { trackId: newId(), durationMs: 1 }]
    expect(await a.send({ type: 'enqueue', tracks: fits, placement: 'next' })).toMatchObject({ ok: true })
    expect((await getSnapshot(user.id)).queue.queue).toHaveLength(QUEUE_LIMIT)

    expect(await a.send({ type: 'enqueue', tracks: many(1), placement: 'last' })).toEqual({ ok: false, error: 'queue_full' })
    expect(await a.send({ type: 'enqueue', tracks: many(2), placement: 'next' })).toEqual({ ok: false, error: 'queue_full' })
    expect((await getSnapshot(user.id)).queue.queue).toHaveLength(QUEUE_LIMIT)
    expect(await a.send({ type: 'playTracks', tracks: many(COMMAND_TRACK_LIMIT), seed: 1 })).toMatchObject({ ok: true })
    expect((await getSnapshot(user.id)).queue.queue).toHaveLength(COMMAND_TRACK_LIMIT - 1)
  })

  it('acks commands past the rate limit rate_limited without applying them', async () => {
    const a = await device('device-a-0020')
    expect(await a.send(playAlbum())).toEqual({ ok: true, version: 1 })
    const acks = await Promise.all(Array.from({ length: 60 }, (_, index) => a.send({ type: 'seek', positionMs: (index + 1) * 1000 })))
    // The burst left 39 tokens; one or two more may refill while the rest arrive.
    expect(acks.slice(0, 39).every((ack) => ack.ok)).toBe(true)
    const limited = acks.filter((ack) => !ack.ok)
    expect(limited.length).toBeGreaterThanOrEqual(15)
    expect(limited).toEqual(limited.map(() => ({ ok: false, error: 'rate_limited' })))
    // Every seek that went through moved the position, and none of the others did.
    expect((await getSnapshot(user.id)).version).toBe(1 + acks.length - limited.length)
  })

  it('prepares on-demand tracks and follows them to ready or failed', async () => {
    const remote = await createAlbum({ tracks: [{ title: 'Far' }, { title: 'Farther' }, { title: 'Farthest' }] })
    const [far, farther, farthest] = remote.tracks.map((track) => track.recordingId) as [string, string, string]
    for (const id of [far, farther, farthest]) onDemand.add(id)
    const a = await device('device-a-0012')
    const tracks = [far, album.tracks[0]!.recordingId, farther, farthest].map((trackId) => ({ trackId, albumId: remote.albumId, durationMs: 1 }))
    await a.send({ type: 'playTracks', tracks, seed: 1 })
    const state = await a.state(1)
    expect(state).toMatchObject({ stalled: true, playing: true, current: { trackId: far, state: 'preparing' } })
    // The current entry as `play`, the next ones as `prefetch`; the owned one needs nothing.
    const requests = () => vi.mocked(requestRecording).mock.calls.map(([request]) => [request.recordingId, request.origin])
    await eventually(requests, (value) => expect(value).toEqual([[far, 'play'], [farther, 'prefetch'], [farthest, 'prefetch']]))
    expect(vi.mocked(requestRecording).mock.calls[0]![0]).toEqual({ userId: user.id, recordingId: far, albumId: remote.albumId, origin: 'play' })

    await markRecordingReady(far)
    expect(await a.state(2)).toMatchObject({ stalled: false, current: { trackId: far, state: 'ready' } })
    await markRecordingFailed(farther)
    await a.state(3)
    expect(a.queues().at(-1)!.queue.queue.map((entry) => [entry.trackId, entry.state])).toEqual([
      [album.tracks[0]!.recordingId, 'ready'], [farther, 'failed'], [farthest, 'preparing'],
    ])
    await a.send({ type: 'next' })
    await a.send({ type: 'next' })
    expect((await a.state(5)).current).toMatchObject({ trackId: farthest, state: 'preparing' })
    // Once current, a prefetched entry is asked for again as what the user waits for.
    await eventually(requests, (value) => expect(value).toEqual([[far, 'play'], [farther, 'prefetch'], [farthest, 'prefetch'], [farthest, 'play']]))

    // A session loaded from the database re-checks its preparing entries.
    await sessionsModule.stop!()
    const root = await createLibraryRoot()
    await db.insert(mediaFiles).values({ id: newId(), rootId: root.id, relPath: 'farthest.flac', size: 1, mtime: new Date(), container: 'flac', codec: 'flac', durationMs: 1000, recordingId: farthest })
    expect((await getSnapshot(user.id)).state).toMatchObject({ stalled: false, current: { trackId: farthest, state: 'ready' } })
  })

  describe('on demand', () => {
    /** An album of `count` tracks the server has no file for, all on demand. */
    async function remoteAlbum(count: number) {
      const remote = await createAlbum({ tracks: Array.from({ length: count }, (_, index) => ({ title: `Remote ${index + 1}` })) })
      const ids = remote.tracks.map((track) => track.recordingId)
      for (const id of ids) onDemand.add(id)
      return { albumId: remote.albumId, ids, seeds: ids.map((trackId) => ({ trackId, albumId: remote.albumId, durationMs: 1 })) }
    }
    const requests = () => vi.mocked(requestRecording).mock.calls.map(([request]) => [request.recordingId, request.origin])
    const queued = (peer: Peer) => peer.queues().at(-1)!.queue.queue.map((entry) => [entry.trackId, entry.state])
    const stops = (peer: Peer) => (peer.events('event') as ServerEvent[]).filter((event) => event.type === 'playback.unavailable')

    it('keeps on-demand tracks out of the queue of a user who may not have tracks fetched', async () => {
      const remote = await remoteAlbum(1)
      const member = await newUser()
      const a = await device('device-a-0030', { token: member.token })
      const owned = album.tracks[0]!.recordingId
      const tracks = [{ trackId: owned, albumId: album.albumId, durationMs: 1 }, ...remote.seeds]
      expect(await a.send({ type: 'playTracks', tracks, startIndex: 1, seed: 1 })).toEqual({ ok: true, version: 1 })
      expect((await a.state(1)).current).toMatchObject({ trackId: owned, state: 'ready' })
      expect(a.queues()[0]!.queue.queue).toEqual([])
      expect(await a.send({ type: 'enqueue', tracks: remote.seeds, placement: 'next' })).toEqual({ ok: false, error: 'nothing_playable' })
      expect(requestRecording).not.toHaveBeenCalled()
    })

    it('prepares the current entry and the next five, current first, in queue order', async () => {
      const remote = await remoteAlbum(13)
      const a = await device('device-a-0031')
      await a.send({ type: 'playTracks', tracks: remote.seeds, seed: 1 })
      await a.state(1)
      const expected = remote.ids.slice(0, 6).map((id, index) => [id, index === 0 ? 'play' : 'prefetch'])
      await eventually(requests, (value) => expect(value).toEqual(expected))

      await a.send({ type: 'next' })
      await eventually(requests, (value) => expect(value).toEqual([...expected, [remote.ids[1], 'play'], [remote.ids[6], 'prefetch']]))
    })

    it('marks a prefetched entry that fails quietly while the current one loads, and skips it when reached', async () => {
      const remote = await remoteAlbum(4)
      const [first, second, third, fourth] = remote.ids as [string, string, string, string]
      const a = await device('device-a-0032')
      await a.send({ type: 'playTracks', tracks: remote.seeds, seed: 1 })
      await a.state(1)
      await markRecordingFailed(third)
      // The current entry still loads, playing; only the third is marked.
      expect(await a.state(2)).toMatchObject({ playing: true, stalled: true, current: { trackId: first, state: 'preparing' } })
      expect(queued(a)).toEqual([[second, 'preparing'], [third, 'failed'], [fourth, 'preparing']])

      await markRecordingReady(first)
      await markRecordingReady(second)
      await a.state(4)
      await a.send({ type: 'trackEnded', entryId: (await a.state(4)).current!.id })
      expect((await a.state(5)).current).toMatchObject({ trackId: second, state: 'ready' })
      await a.send({ type: 'trackEnded', entryId: (await a.state(5)).current!.id })
      expect(await a.state(6)).toMatchObject({ playing: true, current: { trackId: fourth, state: 'preparing' } })
      // Nothing was said to the user at any point, other than why the third failed.
      await new Promise((resolve) => setTimeout(resolve, 100))
      expect(a.events('event')).toEqual([{ type: 'playback.failed', trackId: third, failure: 'error' }])
    })

    it('waits on an entry whose fetch has no answer yet rather than moving past it', async () => {
      // A provider that answers busy has its start queued again: no outcome reaches the session.
      const remote = await remoteAlbum(2)
      const [first] = remote.ids as [string, string]
      const a = await device('device-a-0033')
      await a.send({ type: 'playTracks', tracks: remote.seeds, seed: 1 })
      await a.state(1)
      await new Promise((resolve) => setTimeout(resolve, 200))
      expect(a.states().at(-1)!.state).toMatchObject({ playing: true, stalled: true, current: { trackId: first, state: 'preparing' } })
      expect(requests().filter(([id]) => id === first)).toEqual([[first, 'play']])
      await markRecordingReady(first)
      expect((await a.state(2)).current).toMatchObject({ trackId: first, state: 'ready' })
    })

    it('pauses with one notice after three current entries fail in a row, keeping the queue', async () => {
      const remote = await remoteAlbum(10)
      const ids = remote.ids
      const a = await device('device-a-0034')
      await a.send({ type: 'playTracks', tracks: remote.seeds, seed: 1 })
      await a.state(1)
      await markRecordingFailed(ids[0]!)
      expect(await a.state(2)).toMatchObject({ playing: true, current: { trackId: ids[1] } })
      await markRecordingFailed(ids[1]!)
      expect(await a.state(3)).toMatchObject({ playing: true, current: { trackId: ids[2] } })
      await markRecordingFailed(ids[2]!)
      expect(await a.state(4)).toMatchObject({ playing: false, stalled: false, current: { trackId: ids[2], state: 'failed' } })
      expect(queued(a).map(([id]) => id)).toEqual(ids.slice(3))
      await eventually(() => stops(a), (events) => expect(events).toEqual([{ type: 'playback.unavailable', trackId: ids[2], kind: 'failures', reason: null }]))

      // Play moves on from the failed entry, and the count starts again.
      await a.send({ type: 'play' })
      expect(await a.state(5)).toMatchObject({ playing: true, current: { trackId: ids[3], state: 'preparing' } })
      await markRecordingFailed(ids[3]!)
      await markRecordingFailed(ids[4]!)
      expect(await a.state(7)).toMatchObject({ playing: true, current: { trackId: ids[5], state: 'preparing' } })
      await new Promise((resolve) => setTimeout(resolve, 100))
      expect(stops(a)).toHaveLength(1)
    })

    it('counts failures in a row only: a track that became ready in between starts the count again', async () => {
      const remote = await remoteAlbum(6)
      const ids = remote.ids
      const a = await device('device-a-0035')
      await a.send({ type: 'playTracks', tracks: remote.seeds, seed: 1 })
      await a.state(1)
      await markRecordingFailed(ids[0]!)
      await markRecordingFailed(ids[1]!)
      await markRecordingReady(ids[2]!)
      const playing = await a.state(4)
      expect(playing.current).toMatchObject({ trackId: ids[2], state: 'ready' })
      await a.send({ type: 'trackEnded', entryId: playing.current!.id })
      await markRecordingFailed(ids[3]!)
      await markRecordingFailed(ids[4]!)
      expect(await a.state(7)).toMatchObject({ playing: true, current: { trackId: ids[5], state: 'preparing' } })
      expect(stops(a)).toEqual([])
    })

    it('skips tracks the provider does not have and plays on, however many in a row', async () => {
      const remote = await remoteAlbum(6)
      const ids = remote.ids
      const a = await device('device-a-0036')
      await a.send({ type: 'playTracks', tracks: remote.seeds, seed: 1 })
      await a.state(1)
      for (const [index, id] of ids.slice(0, 4).entries()) {
        await markRecordingFailed(id, { failure: 'unavailable' })
        expect(await a.state(2 + index)).toMatchObject({ playing: true, current: { trackId: ids[index + 1], state: 'preparing' } })
      }
      // Each was said why, before the state that skipped it, and playback never stopped.
      expect(a.events('event')).toEqual(ids.slice(0, 4).map((trackId) => ({ type: 'playback.failed', trackId, failure: 'unavailable' })))
      await markRecordingReady(ids[4]!)
      expect((await a.state(6)).current).toMatchObject({ trackId: ids[4], state: 'ready' })
      expect(stops(a)).toEqual([])
    })

    it('stops once nothing after a track the provider does not have is playable, and says so once', async () => {
      const remote = await remoteAlbum(4)
      const ids = remote.ids
      const a = await device('device-a-0037')
      await a.send({ type: 'playTracks', tracks: remote.seeds, seed: 1 })
      await a.state(1)
      // The ones fetched ahead fail first, quietly.
      for (const id of ids.slice(1)) await markRecordingFailed(id, { failure: 'unavailable' })
      expect(await a.state(4)).toMatchObject({ playing: true, current: { trackId: ids[0], state: 'preparing' } })
      expect(stops(a)).toEqual([])
      await markRecordingFailed(ids[0]!, { failure: 'unavailable' })
      expect(await a.state(5)).toMatchObject({ playing: false, current: { trackId: ids[0], state: 'failed' } })
      await eventually(() => stops(a), (events) => expect(events).toEqual([{ type: 'playback.unavailable', trackId: ids[0], kind: 'exhausted', reason: null }]))
    })

    it('says so once when songs not to be had are skipped one by one to the end of the queue', async () => {
      const remote = await remoteAlbum(3)
      const ids = remote.ids
      const a = await device('device-a-0040')
      await a.send({ type: 'playTracks', tracks: remote.seeds, seed: 1 })
      await a.state(1)
      await markRecordingFailed(ids[0]!, { failure: 'unavailable' })
      await markRecordingFailed(ids[1]!, { failure: 'unavailable' })
      expect(await a.state(3)).toMatchObject({ playing: true, current: { trackId: ids[2], state: 'preparing' } })
      expect(queued(a)).toEqual([])
      await markRecordingFailed(ids[2]!, { failure: 'unavailable' })
      expect(await a.state(4)).toMatchObject({ playing: false, current: { trackId: ids[2], state: 'failed' } })
      await eventually(() => stops(a), (events) => expect(events).toEqual([{ type: 'playback.unavailable', trackId: ids[2], kind: 'exhausted', reason: null }]))
    })

    it('says nothing more than why when the last track of the queue is not available', async () => {
      const remote = await remoteAlbum(1)
      const a = await device('device-a-0038')
      await a.send({ type: 'playTracks', tracks: remote.seeds, seed: 1 })
      await a.state(1)
      await markRecordingFailed(remote.ids[0]!, { failure: 'unavailable' })
      expect(await a.state(2)).toMatchObject({ playing: false, current: { trackId: remote.ids[0], state: 'failed' } })
      await new Promise((resolve) => setTimeout(resolve, 100))
      expect(a.events('event')).toEqual([{ type: 'playback.failed', trackId: remote.ids[0], failure: 'unavailable' }])
    })

    it('pauses on the first failure of an outage, with its reason, and fetches nothing more', async () => {
      const remote = await remoteAlbum(4)
      const ids = remote.ids
      const a = await device('device-a-0039')
      await a.send({ type: 'playTracks', tracks: remote.seeds, seed: 1 })
      await a.state(1)
      await eventually(requests, (value) => expect(value).toHaveLength(4))
      await markRecordingFailed(ids[0]!, { failure: 'outage', reason: 'Fetching is down.' })
      expect(await a.state(2)).toMatchObject({ playing: false, current: { trackId: ids[0], state: 'failed' } })
      expect(queued(a).map(([id]) => id)).toEqual(ids.slice(1))
      expect(a.events('event')).toEqual([
        { type: 'playback.failed', trackId: ids[0], failure: 'outage' },
        { type: 'playback.unavailable', trackId: ids[0], kind: 'outage', reason: 'Fetching is down.' },
      ])
    })
  })

  it('follows a recording merged while its entry was preparing, taking its id and length', async () => {
    const stub = await createAlbum({ tracks: [{ title: 'Razorblade', durationMs: 207_000 }, { title: 'Juicebox', durationMs: 180_000 }] })
    const real = await createAlbum({ tracks: [{ title: 'Razorblade', durationMs: 209_226 }] })
    const [razorblade, juicebox] = stub.tracks.map((track) => track.recordingId) as [string, string]
    const delivered = real.tracks[0]!.recordingId
    for (const id of [razorblade, juicebox, delivered]) onDemand.add(id)
    const a = await device('device-a-0031')
    await a.send({ type: 'playTracks', tracks: [razorblade, juicebox].map((trackId) => ({ trackId, albumId: stub.albumId, durationMs: 1 })), seed: 1 }, 'merged')
    expect(await a.state(1)).toMatchObject({ current: { id: 'merged.0', trackId: razorblade, durationMs: 207_000, state: 'preparing' } })
    await eventually(() => vi.mocked(requestRecording).mock.calls.length, (count) => expect(count).toBe(2))

    // Acquisition links the file to the row it identified, merging the stub into it, and
    // answers for that row.
    await mergeRecording(razorblade, delivered)
    await db.update(albums).set({ mergedIntoId: real.albumId }).where(eq(albums.id, stub.albumId))
    const root = await createLibraryRoot()
    await db.insert(mediaFiles).values({ id: newId(), rootId: root.id, relPath: 'razorblade.flac', size: 1, mtime: new Date(), container: 'flac', codec: 'flac', durationMs: 209_226, recordingId: delivered })
    await markRecordingReady(delivered)
    await eventually(() => getSnapshot(user.id), (snapshot) => expect(snapshot.state).toMatchObject({
      stalled: false,
      current: { id: 'merged.0', trackId: delivered, albumId: real.albumId, durationMs: 209_226, state: 'ready' },
    }))
    expect((await getSnapshot(user.id)).queue.queue).toEqual([{ id: 'merged.1', trackId: juicebox, albumId: real.albumId, durationMs: 180_000, state: 'preparing' }])
  })

  it('looks the current entry and the next ones up again as playback moves on', async () => {
    const queued = await createAlbum({ owned: true, tracks: [{ title: 'One', durationMs: 100_000 }, { title: 'Two', durationMs: 200_000 }] })
    const matched = await createAlbum({ owned: true, tracks: [{ title: 'Two', durationMs: 201_500 }] })
    const [one, two] = queued.tracks.map((track) => track.recordingId) as [string, string]
    const a = await device('device-a-0032')
    await a.send({ type: 'playTracks', tracks: [one, two].map((trackId) => ({ trackId, albumId: queued.albumId, durationMs: 1 })), seed: 1 })
    await a.state(1)
    // Matching merges the library's row into the catalog's after it was queued.
    await mergeRecording(two, matched.tracks[0]!.recordingId)
    await a.send({ type: 'next' })
    await eventually(() => getSnapshot(user.id), (snapshot) => expect(snapshot.state.current).toMatchObject({ trackId: matched.tracks[0]!.recordingId, durationMs: 201_500, state: 'ready' }))
  })

  it('fails an on-demand entry whose request could not be made, rather than leave it preparing', async () => {
    const remote = await createAlbum({ tracks: [{ title: 'Unreachable' }] })
    const far = remote.tracks[0]!.recordingId
    onDemand.add(far)
    vi.mocked(requestRecording).mockRejectedValueOnce(new Error('connection terminated'))
    const a = await device('device-a-0020')
    const tracks = [far, album.tracks[0]!.recordingId].map((trackId) => ({ trackId, albumId: remote.albumId, durationMs: 1 }))
    await a.send({ type: 'playTracks', tracks, seed: 1 })
    expect((await a.state(1)).current).toMatchObject({ trackId: far, state: 'preparing' })
    expect((await a.state(2)).current).toMatchObject({ trackId: album.tracks[0]!.recordingId, state: 'ready' })
  })

  it('asks again for an on-demand track that left the queue before its answer came', async () => {
    const remote = await createAlbum({ tracks: [{ title: 'Again' }] })
    const far = remote.tracks[0]!.recordingId
    onDemand.add(far)
    const a = await device('device-a-0021')
    const play = (...trackIds: string[]) => a.send({ type: 'playTracks', tracks: trackIds.map((trackId) => ({ trackId, albumId: remote.albumId, durationMs: 1 })), seed: 1 })
    // Requested while up next, then gone with the queue it was in.
    await play(album.tracks[0]!.recordingId, far)
    await play(album.tracks[1]!.recordingId)
    await a.state(2)
    // The fetch failed while the session no longer held the track; it is still on demand.
    await markRecordingFailed(far)
    await play(far)
    expect((await a.state(3)).current).toMatchObject({ trackId: far, state: 'preparing' })
    expect(vi.mocked(requestRecording).mock.calls.map(([request]) => request.recordingId)).toEqual([far, far])
  })

  it('refills autoplay from the radio module once per entry, and never loops on an empty answer', async () => {
    const extra = await createAlbum({ owned: true, tracks: [{ title: 'Suggested' }] })
    const suggestion: QueueSeed = { trackId: extra.tracks[0]!.recordingId, albumId: extra.albumId, durationMs: extra.tracks[0]!.durationMs, state: 'ready' }
    vi.mocked(suggestAutoplay).mockResolvedValueOnce([]).mockResolvedValueOnce([suggestion])
    const a = await device('device-a-0013')
    const [first, second] = album.tracks

    await a.send({ type: 'playTracks', tracks: seeds([first!]), seed: 1 })
    await a.state(1)
    await a.send({ type: 'pause' })
    await a.send({ type: 'play' })
    await a.state(3)
    expect(suggestAutoplay).toHaveBeenCalledTimes(1)
    expect(suggestAutoplay).toHaveBeenCalledWith({ userId: user.id, seeds: [first!.recordingId], exclude: [first!.recordingId], limit: 10 })

    await a.send({ type: 'playTracks', tracks: seeds([second!]), seed: 1 })
    await eventually(() => a.queues().at(-1)!.queue.autoplayQueue.map((entry) => entry.trackId), (value) => expect(value).toEqual([suggestion.trackId]))
    expect(suggestAutoplay).toHaveBeenCalledTimes(2)
    expect(vi.mocked(suggestAutoplay).mock.calls[1]![0].seeds).toEqual([first!.recordingId, second!.recordingId])
  })

  it('accounts plays from the anchor arithmetic: pauses and seeks add nothing, skips write nothing', async () => {
    const clock = stoppedClock()
    const start = clock.now()
    const a = await device('device-a-0014')
    const [first, , third] = album.tracks
    await a.send(playAlbum(), 'acct')
    await a.state(1)
    clock.advance(60_000)
    await a.send({ type: 'pause' })
    clock.advance(300_000)
    await a.send({ type: 'play' })
    clock.advance(20_000)
    await a.send({ type: 'seek', positionMs: 170_000 })
    clock.advance(30_000) // capped: only 10 s remain
    await a.send({ type: 'seek', positionMs: 0 })
    clock.advance(5_000)
    await a.send({ type: 'next' })
    await a.state(6)
    clock.advance(2_000)
    await a.send({ type: 'next' })
    clock.advance(500_000)
    await a.send({ type: 'trackEnded', entryId: 'acct.2' })
    expect(await a.state(8)).toMatchObject({ playing: false, current: { id: 'acct.2' } })

    await eventually(() => db.select().from(plays).where(eq(plays.userId, user.id)).orderBy(plays.startedAt), (rows) => expect(rows).toMatchObject([
      { recordingId: first!.recordingId, albumId: album.albumId, deviceId: 'device-a-0014', client: 'app', msPlayed: 95_000, completed: true, startedAt: new Date(start) },
      { recordingId: third!.recordingId, msPlayed: third!.durationMs, completed: true },
    ]))
    await eventually(() => a.events('invalidate'), (value) => expect(value).toContainEqual({ keys: [['history'], ['home']] }))
  })

  it('records a play under the album and recording its track resolves to when it closes', async () => {
    const clock = stoppedClock()
    // A catalog stub named as the queue's album: it has no tracks of its own.
    const stub = await createAlbum({ tracks: [] })
    const fetched = await createAlbum({ owned: true, tracks: [{ title: 'Fetched' }, { title: 'Also fetched' }] })
    const [first, second] = fetched.tracks as [typeof fetched.tracks[0], typeof fetched.tracks[0]]
    const a = await device('device-a-0018')
    const tracks = [first, second].map((track) => ({ trackId: track.recordingId, albumId: stub.albumId, durationMs: 1 }))
    await a.send({ type: 'playTracks', tracks, seed: 1 })
    await a.state(1)
    clock.advance(30_000)
    await a.send({ type: 'next' })
    clock.advance(30_000)
    // Identification merges the recording while it plays.
    const winner = (await createAlbum({ tracks: [{ title: 'Canonical' }] })).tracks[0]!.recordingId
    await mergeRecording(second.recordingId, winner)
    await a.send({ type: 'pause' })
    await a.send({ type: 'next' })
    await a.state(4)
    await eventually(() => db.select({ recordingId: plays.recordingId, albumId: plays.albumId }).from(plays).where(eq(plays.userId, user.id)).orderBy(plays.startedAt), (rows) => expect(rows).toEqual([
      { recordingId: first.recordingId, albumId: fetched.albumId },
      { recordingId: winner, albumId: fetched.albumId },
    ]))
  })

  it('keeps one play row for a listen that spans a restart', async () => {
    const clock = stoppedClock()
    const a = await device('device-a-0019')
    await a.send(playAlbum(), 'span')
    await a.state(1)
    clock.advance(60_000)
    await sessionsModule.stop!()
    clock.advance(30_000)
    // The device kept playing; its next report re-anchors the reloaded session.
    expect(await a.send({ type: 'seek', positionMs: 90_000 })).toEqual({ ok: true, version: 2 })
    clock.advance(30_000)
    await a.send({ type: 'next' })
    await a.state(3)
    await sessionsModule.stop!()
    expect(await db.select({ recordingId: plays.recordingId, msPlayed: plays.msPlayed }).from(plays).where(eq(plays.userId, user.id)))
      .toEqual([{ recordingId: album.tracks[0]!.recordingId, msPlayed: 120_000 }])
  })

  it('waits for the write of a play that closed just before shutdown', async () => {
    const clock = stoppedClock()
    const a = await device('device-a-0017')
    await a.send(playAlbum(), 'late')
    await a.state(1)
    clock.advance(60_000)
    let stopped = false
    let stopping: Promise<void> | undefined
    // Holding the table lock keeps the play's insert waiting while the sessions stop.
    await db.transaction(async (tx) => {
      await tx.execute(sql`lock table plays in exclusive mode`)
      await a.send({ type: 'next' })
      stopping = Promise.resolve(sessionsModule.stop!()).then(() => { stopped = true })
      await new Promise((resolve) => setTimeout(resolve, 200))
      expect(stopped).toBe(false)
    })
    await stopping
    expect(await db.select({ recordingId: plays.recordingId, msPlayed: plays.msPlayed }).from(plays).where(eq(plays.userId, user.id)))
      .toEqual([{ recordingId: album.tracks[0]!.recordingId, msPlayed: 60_000 }])
  })

  it('tells play-start listeners once per play that starts on the active device', async () => {
    const started: string[] = []
    const unsubscribe = onPlayStart((userId, play) => {
      if (userId === user.id) started.push(play.recordingId)
    })
    try {
      const a = await device('device-a-0016')
      const [first, second] = album.tracks
      await a.send(playAlbum(), 'start')
      await a.state(1)
      await a.send({ type: 'pause' })
      await a.send({ type: 'play' })
      await a.send({ type: 'next' })
      await a.state(4)
      expect(started).toEqual([first!.recordingId, second!.recordingId])
    } finally {
      unsubscribe()
    }
  })

  it('re-anchors on engine reports that drift or stall, and ignores the rest', async () => {
    const clock = stoppedClock()
    const a = await device('device-a-0015')
    const b = await device('device-b-0015')
    await a.send(playAlbum(), 'rep')
    await b.state(1)
    clock.advance(10_000)
    const at = clock.now()
    b.socket.emit('session:report', { entryId: 'rep.0', status: 'playing', positionMs: 20_000, at })
    a.socket.emit('session:report', { entryId: 'rep.0', status: 'playing', positionMs: 10_500, at })
    a.socket.emit('session:report', { entryId: 'rep.1', status: 'playing', positionMs: 0, at })
    a.socket.emit('session:report', { entryId: 'rep.0', status: 'buffering', positionMs: 9_000, at })
    expect(await b.state(2)).toMatchObject({ positionMs: 9_000, anchorAt: at, stalled: true })
    clock.advance(3_000)
    a.socket.emit('session:report', { entryId: 'rep.0', status: 'playing', positionMs: 9_000, at: clock.now() })
    expect(await b.state(3)).toMatchObject({ positionMs: 9_000, anchorAt: clock.now(), stalled: false })
    expect(b.states().map((update) => update.version)).toEqual([1, 2, 3])
  })

  it('replaces the queue for Subsonic and records external plays', async () => {
    const a = await device('device-a-0016')
    const ids = album.tracks.map((track) => track.recordingId)
    const snapshot = await replaceQueue(user.id, { trackIds: [newId(), ...ids], currentId: ids[1], positionMs: 12_000 })
    expect(snapshot.state).toMatchObject({ playing: false, positionMs: 12_000, current: { trackId: ids[1], durationMs: album.tracks[1]!.durationMs } })
    expect(snapshot.queue.queue.map((entry) => entry.trackId)).toEqual([ids[2]])
    expect((await a.state(snapshot.version)).current?.trackId).toBe(ids[1])
    expect((await replaceQueue(user.id, { trackIds: [] })).queue.queue).toEqual([])

    // A Subsonic client may save far more ids than a session holds or one query may bind.
    const unknown = Array.from({ length: 70_000 }, () => newId())
    const huge = await replaceQueue(user.id, { trackIds: [...unknown.slice(0, 10), ...ids, ...unknown], currentId: ids[0] })
    expect(huge.state.current?.trackId).toBe(ids[0])
    expect(huge.queue.queue.map((entry) => entry.trackId)).toEqual(ids.slice(1))
    const long = Array.from({ length: COMMAND_TRACK_LIMIT + 50 }, (_, index) => ids[index % ids.length]!)
    const capped = await replaceQueue(user.id, { trackIds: long, currentId: ids[1] })
    expect(capped.state.current?.trackId).toBe(ids[1])
    expect(capped.queue.queue).toHaveLength(COMMAND_TRACK_LIMIT - 1)

    expect(await recordExternalPlay(user.id, newId())).toBe(false)
    expect(await recordExternalPlay(user.id, ids[0]!, { playedAt: new Date('2026-01-01T00:00:00Z') })).toBe(true)
    expect(await db.select().from(plays).where(eq(plays.userId, user.id))).toMatchObject([
      { recordingId: ids[0], client: 'subsonic', msPlayed: album.tracks[0]!.durationMs, completed: true, startedAt: new Date('2026-01-01T00:00:00Z') },
    ])
  })
})
