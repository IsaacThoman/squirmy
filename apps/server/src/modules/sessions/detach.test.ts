import type { AddressInfo } from 'node:net'
import type {
  ClientToServerEvents, CommandAck, DeviceInfo, QueueSeed, ServerToClientEvents, SessionCommand, SessionHello, SessionHelloAck,
  SessionMoveAck, SessionState,
} from '@squirmy/contracts'
import { eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { io as connect, type Socket } from 'socket.io-client'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildApp } from '../../app.js'
import { db } from '../../database/client.js'
import { detachedSessions, plays } from '../../database/schema.js'
import { startRealtime } from '../../realtime/index.js'
import { useTestDatabase } from '../../test/database.js'
import { createAlbum, createUser } from '../../test/factories.js'
import { createSession } from '../auth/service.js'
import { sessionsModule } from './index.js'
import { configureSessions, getSnapshot } from './service.js'

vi.mock('../acquisition/coverage.js', () => ({
  onDemandRecordings: vi.fn(async () => new Set<string>()),
  requestRecording: vi.fn(async () => {}),
}))
vi.mock('../radio/suggest.js', () => ({ suggestAutoplay: vi.fn(async () => []) }))

type Client = Socket<ServerToClientEvents, ClientToServerEvents>
type Logged = [event: string, payload: unknown]

async function eventually<T>(read: () => T | Promise<T>, check: (value: T) => void, timeoutMs = 5000): Promise<void> {
  const deadline = performance.now() + timeoutMs
  for (;;) {
    try {
      // `read` may throw too: a socket's first event of a kind can land a read after the one waited on.
      check(await read())
      return
    } catch (error) {
      if (performance.now() > deadline) throw error
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

const DAY_MS = 24 * 60 * 60_000

/** A raw socket.io client speaking for one device, logging what it receives in order. */
class Peer {
  readonly log: Logged[] = []
  private serial = 0

  constructor(readonly socket: Client, readonly deviceId: string) {
    for (const event of ['session:state', 'session:queue', 'session:moved', 'devices'] as const) {
      socket.on(event, (payload: unknown) => this.log.push([event, payload]))
    }
  }

  /** `detached` as a client that can detach sends it; leave it out to speak like an older client. */
  hello(options: { canPlay?: boolean; detached?: boolean } = {}): Promise<SessionHelloAck> {
    const hello: SessionHello = { device: { id: this.deviceId, name: this.deviceId, kind: 'web' }, canPlay: options.canPlay ?? true }
    if (options.detached !== undefined) hello.detached = options.detached
    return this.socket.emitWithAck('session:hello', hello)
  }

  /** Command ids are unique per socket: two sockets of one device share a session. */
  send(command: SessionCommand, commandId = `${this.socket.id}-${++this.serial}`): Promise<CommandAck> {
    return this.socket.emitWithAck('session:command', { commandId, command })
  }

  detach(): Promise<SessionMoveAck> {
    return this.socket.emitWithAck('session:detach', {})
  }

  attach(bringQueue?: boolean): Promise<SessionMoveAck> {
    return this.socket.emitWithAck('session:attach', bringQueue === undefined ? {} : { bringQueue })
  }

  events<T>(name: string): T[] {
    return this.log.filter(([event]) => event === name).map(([, payload]) => payload as T)
  }

  states(): { version: number; state: SessionState }[] {
    return this.events('session:state')
  }

  lastState(): SessionState | undefined {
    return this.states().at(-1)?.state
  }

  lastDevices(): DeviceInfo[] | undefined {
    return this.events<DeviceInfo[]>('devices').at(-1)
  }
}

describe('detached sessions', () => {
  useTestDatabase()
  let app: FastifyInstance
  let url = ''
  const sockets: Client[] = []
  let album: Awaited<ReturnType<typeof createAlbum>>
  let other: Awaited<ReturnType<typeof createAlbum>>
  let user: { id: string; token: string }
  let time = 0

  beforeAll(async () => {
    app = await buildApp()
    await sessionsModule.realtime!(await startRealtime(app))
    await app.listen({ host: '127.0.0.1', port: 0 })
    url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`
    album = await createAlbum({ owned: true, tracks: [{ title: 'One', durationMs: 200_000 }, { title: 'Two', durationMs: 200_000 }, { title: 'Three', durationMs: 200_000 }] })
    other = await createAlbum({ owned: true, tracks: [{ title: 'Elsewhere', durationMs: 100_000 }] })
  })
  beforeEach(async () => {
    time = 1_800_000_000_000
    configureSessions({ deviceGraceMs: 20_000, now: () => time, timers: null })
    const row = await createUser()
    user = { id: row.id, token: (await createSession(db, { userId: row.id, clientKind: 'test' })).token }
  })
  afterEach(async () => {
    for (const socket of sockets.splice(0)) socket.disconnect()
    await sessionsModule.stop!()
  })
  afterAll(async () => {
    await app.close()
  })

  async function open(deviceId: string): Promise<Peer> {
    const socket: Client = connect(url, { path: '/socket.io', transports: ['websocket'], reconnection: false, auth: { token: user.token } })
    sockets.push(socket)
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve)
      socket.once('connect_error', reject)
    })
    return new Peer(socket, deviceId)
  }

  async function device(deviceId: string, options: { canPlay?: boolean; detached?: boolean } = {}): Promise<Peer> {
    const peer = await open(deviceId)
    await peer.hello({ detached: false, ...options })
    return peer
  }

  /** Closes a peer's socket and waits until the server has seen it go. */
  async function close(peer: Peer, watcher: Peer): Promise<void> {
    const listed = () => watcher.lastDevices()?.map((item) => item.id)
    await eventually(listed, (ids) => expect(ids).toContain(peer.deviceId))
    peer.socket.disconnect()
    await eventually(listed, (ids) => expect(ids).not.toContain(peer.deviceId))
  }

  const seeds = (from = album): QueueSeed[] => from.tracks.map((track) => ({ trackId: track.recordingId, albumId: from.albumId, durationMs: 0 }))
  const play = (from = album): SessionCommand => ({ type: 'playTracks', tracks: seeds(from), seed: 1, context: { type: 'album', id: from.albumId, title: from.title } })
  const ok = (reply: SessionMoveAck) => {
    if (!reply.ok) throw new Error(`refused: ${reply.error}`)
    return reply
  }
  const storedRows = () => db.select().from(detachedSessions).where(eq(detachedSessions.userId, user.id))

  it('says it can detach, and which session a snapshot is of', async () => {
    const a = await device('device-a-1')
    const reply = await a.hello({ detached: false })
    expect(reply.capabilities).toContain('detach')
    expect(reply.snapshot.scope).toEqual({ type: 'shared' })
    expect(reply.detachedEnded).toBeUndefined()
  })

  it('takes the active device out playing without a gap and leaves the shared session paused', async () => {
    const a = await device('device-a-2')
    const b = await device('device-b-2')
    await a.send(play())
    time += 30_000
    const before = (await getSnapshot(user.id))
    const moved = ok(await a.detach())

    expect(moved.snapshot.scope).toEqual({ type: 'device', deviceId: 'device-a-2' })
    expect(moved.snapshot.state).toEqual(before.state)
    expect(moved.snapshot.queue).toEqual(before.queue)
    expect(moved.snapshot.version).toBe(before.version)

    await eventually(() => b.lastState(), (state) => expect(state).toMatchObject({ activeDeviceId: null, playing: false, positionMs: 30_000 }))
    const shared = await getSnapshot(user.id)
    expect(shared.state.current?.id).toBe(before.state.current?.id)

    // Both lists say A plays on its own, and that the shared session cannot go there.
    const listed = { id: 'device-a-2', canPlay: false, isActive: false, detached: { playing: true, trackId: album.tracks[0]!.recordingId, albumId: album.albumId } }
    await eventually(() => b.lastDevices(), (list) => expect(list).toContainEqual(expect.objectContaining(listed)))
    expect(moved.devices).toContainEqual(expect.objectContaining(listed))
    expect(await storedRows()).toHaveLength(1)
  })

  it('gives a device that was not playing a paused copy and leaves the shared session alone', async () => {
    const a = await device('device-a-3')
    const b = await device('device-b-3')
    await a.send(play())
    time += 10_000
    const moved = ok(await b.detach())
    expect(moved.snapshot.state).toMatchObject({ playing: false, activeDeviceId: null, positionMs: 10_000, anchorAt: time })
    expect((await getSnapshot(user.id)).state).toMatchObject({ playing: true, activeDeviceId: 'device-a-3' })
    await eventually(() => a.lastDevices()?.find((item) => item.id === 'device-b-3')?.detached, (value) => expect(value).toEqual({ playing: false, trackId: album.tracks[0]!.recordingId, albumId: album.albumId }))
  })

  it('keeps each session to its own sockets', async () => {
    const a = await device('device-a-4')
    const b = await device('device-b-4')
    await a.send(play())
    ok(await a.detach())
    await eventually(() => b.lastState(), (state) => expect(state?.activeDeviceId).toBeNull())
    const aSeen = a.states().length
    const bSeen = b.states().length

    expect(await b.send(play(other))).toMatchObject({ ok: true })
    expect(await a.send({ type: 'next' })).toMatchObject({ ok: true })
    await eventually(() => b.states().length, (count) => expect(count).toBe(bSeen + 1))
    await eventually(() => a.states().length, (count) => expect(count).toBe(aSeen + 1))
    expect(b.lastState()?.current?.trackId).toBe(other.tracks[0]!.recordingId)
    expect(a.lastState()?.current?.trackId).toBe(album.tracks[1]!.recordingId)
    expect((await getSnapshot(user.id)).state.current?.trackId).toBe(other.tracks[0]!.recordingId)
    // B played in the shared session, so it became its active device; A's list says what A plays now.
    await eventually(() => b.lastDevices()?.find((item) => item.id === 'device-a-4')?.detached?.trackId, (value) => expect(value).toBe(album.tracks[1]!.recordingId))
  })

  it('refuses what crosses between sessions, and detaching a device that cannot play', async () => {
    const a = await device('device-a-5')
    const b = await device('device-b-5')
    const remote = await device('device-r-5', { canPlay: false })
    const silent = await open('device-s-5')
    expect(await silent.detach()).toEqual({ ok: false, error: 'hello_required' })
    expect(await remote.detach()).toEqual({ ok: false, error: 'cannot_play' })
    await b.send(play())
    ok(await a.detach())
    expect(await b.send({ type: 'transfer', deviceId: 'device-a-5' })).toEqual({ ok: false, error: 'device_unavailable' })
    expect(await a.send({ type: 'transfer', deviceId: 'device-b-5' })).toEqual({ ok: false, error: 'device_unavailable' })
    expect(await a.send({ type: 'transfer', deviceId: 'device-a-5' })).toMatchObject({ ok: true })
    expect((await getSnapshot(user.id)).state.activeDeviceId).toBe('device-b-5')
  })

  it('answers repeated moves with the session the device is already in', async () => {
    const a = await device('device-a-6')
    expect(ok(await a.attach()).snapshot.scope).toEqual({ type: 'shared' })
    const first = ok(await a.detach())
    const second = ok(await a.detach())
    expect(second.snapshot).toEqual(first.snapshot)
    expect(await storedRows()).toHaveLength(1)
  })

  it('moves the other sockets of the device along', async () => {
    const a = await device('device-a-7')
    const tab = await device('device-a-7')
    const b = await device('device-b-7')
    await a.send(play())
    ok(await a.detach())
    await eventually(() => tab.events<SessionHelloAck>('session:moved'), (moves) => expect(moves.at(-1)?.snapshot.scope).toEqual({ type: 'device', deviceId: 'device-a-7' }))
    expect(a.events('session:moved')).toEqual([])
    await tab.send({ type: 'pause' })
    await eventually(() => a.lastState(), (state) => expect(state?.playing).toBe(false))
    // B's pause came from the detach, on another socket, so it is not ordered with A's events.
    await eventually(() => b.lastState(), (state) => expect(state?.playing).toBe(false))
    // A further socket joins the session the device is in.
    const late = await open('device-a-7')
    expect((await late.hello({ detached: false })).snapshot.scope).toEqual({ type: 'device', deviceId: 'device-a-7' })
  })

  it('attaches as a remote and discards the own session', async () => {
    const a = await device('device-a-8')
    const b = await device('device-b-8')
    await b.send(play(other))
    ok(await a.detach())
    await a.send(play())
    const back = ok(await a.attach())
    expect(back.snapshot.scope).toEqual({ type: 'shared' })
    expect(back.snapshot.state).toMatchObject({ activeDeviceId: 'device-b-8', playing: true, current: { trackId: other.tracks[0]!.recordingId } })
    expect(await storedRows()).toEqual([])
    await eventually(() => b.lastDevices()?.find((item) => item.id === 'device-a-8'), (item) => expect(item).toMatchObject({ canPlay: true }))
    expect(b.lastDevices()?.find((item) => item.id === 'device-a-8')?.detached).toBeUndefined()
    // Back in the shared session, A sees and moves its updates again.
    await b.send({ type: 'pause' })
    await eventually(() => a.lastState(), (state) => expect(state).toMatchObject({ playing: false, activeDeviceId: 'device-b-8' }))
  })

  it('brings its queue back, taking over the shared session without a gap', async () => {
    const a = await device('device-a-9')
    const b = await device('device-b-9')
    ok(await a.detach())
    expect(await a.attach(true)).toEqual({ ok: false, error: 'nothing_to_bring' })
    await b.send(play(other))
    await a.send(play())
    time += 5_000
    await a.send({ type: 'next' })
    time += 12_000
    const { state: own, queue: ownQueue } = ok(await a.detach()).snapshot

    const back = ok(await a.attach(true))
    expect(back.snapshot.scope).toEqual({ type: 'shared' })
    expect(back.snapshot.state).toMatchObject({ activeDeviceId: 'device-a-9', playing: true, current: own.current, positionMs: own.positionMs, anchorAt: own.anchorAt })
    expect(back.snapshot.queue).toMatchObject({ queue: ownQueue.queue, history: ownQueue.history })
    await eventually(() => b.lastState(), (state) => expect(state).toMatchObject({ activeDeviceId: 'device-a-9', current: { trackId: album.tracks[1]!.recordingId } }))
    expect(await storedRows()).toEqual([])
  })

  it('counts a play once across detaching and bringing it back', async () => {
    const a = await device('device-a-10')
    await a.send(play())
    time += 20_000
    ok(await a.detach())
    time += 20_000
    ok(await a.attach(true))
    time += 20_000
    await a.send({ type: 'next' })
    await eventually(() => db.select().from(plays).where(eq(plays.userId, user.id)), (rows) => expect(rows).toMatchObject([
      { recordingId: album.tracks[0]!.recordingId, deviceId: 'device-a-10', msPlayed: 60_000 },
    ]))
  })

  it('brings a returning device back to its own session, across a restart', async () => {
    const a = await device('device-a-11')
    const b = await device('device-b-11')
    await a.send(play())
    ok(await a.detach())
    await a.send({ type: 'pause' })
    await close(a, b)
    await sessionsModule.stop!()

    const again = await open('device-a-11')
    const reply = await again.hello({ detached: true })
    expect(reply.snapshot.scope).toEqual({ type: 'device', deviceId: 'device-a-11' })
    expect(reply.snapshot.state).toMatchObject({ playing: false, current: { trackId: album.tracks[0]!.recordingId } })
    expect(reply.detachedEnded).toBeUndefined()

    // The server's record wins over what the client believed.
    await close(again, b)
    const unaware = await open('device-a-11')
    expect((await unaware.hello({ detached: false })).snapshot.scope).toEqual({ type: 'device', deviceId: 'device-a-11' })
  })

  it('remembers the command ids of an own session across a reconnect', async () => {
    const a = await device('device-a-16')
    const b = await device('device-b-16')
    ok(await a.detach())
    await a.send(play())
    const sent = await a.send({ type: 'next' }, 'kept-16')
    expect(sent).toMatchObject({ ok: true })
    await close(a, b)
    const again = await open('device-a-16')
    const reply = await again.hello({ detached: true })
    // The re-sent command is acked with the current version, not applied a second time.
    expect(await again.send({ type: 'next' }, 'kept-16')).toEqual({ ok: true, version: reply.snapshot.version })
    expect((await again.hello({ detached: true })).snapshot.state.current?.trackId).toBe(album.tracks[1]!.recordingId)
  })

  it('puts a device back in the shared session when its client cannot detach', async () => {
    const a = await device('device-a-12')
    const b = await device('device-b-12')
    ok(await a.detach())
    await close(a, b)
    const old = await open('device-a-12')
    const reply = await old.hello({})
    expect(reply.snapshot.scope).toEqual({ type: 'shared' })
    expect(reply.detachedEnded).toBeUndefined()
    expect(await storedRows()).toEqual([])
  })

  it('forgets an own session a week after its device was last seen', async () => {
    const a = await device('device-a-13')
    const b = await device('device-b-13')
    ok(await a.detach())
    await close(a, b)
    time += 7 * DAY_MS + 1
    const again = await open('device-a-13')
    const reply = await again.hello({ detached: true })
    expect(reply).toMatchObject({ snapshot: { scope: { type: 'shared' } }, detachedEnded: 'expired' })
    expect(await storedRows()).toEqual([])

    await close(again, b)
    const believer = await open('device-a-13')
    expect(await believer.hello({ detached: true })).toMatchObject({ snapshot: { scope: { type: 'shared' } }, detachedEnded: 'missing' })
  })

  it('keeps a playing detached device through the grace period, then pauses it', async () => {
    const pending = new Map<number, () => void>()
    let handles = 0
    configureSessions({
      timers: {
        set: (callback) => {
          pending.set(++handles, callback)
          return handles
        },
        clear: (handle) => void pending.delete(handle as number),
      },
    })
    const a = await device('device-a-14')
    const b = await device('device-b-14')
    await a.send(play())
    ok(await a.detach())
    await close(a, b)
    time += 15_000
    const again = await open('device-a-14')
    expect((await again.hello({ detached: true })).snapshot.state).toMatchObject({ playing: true, activeDeviceId: 'device-a-14' })

    await close(again, b)
    time += 5_000
    // It pauses where it was when the device left, not when the grace period ran out.
    expect(pending.size).toBe(1)
    for (const callback of pending.values()) callback()
    await eventually(() => storedRows(), (rows) => expect(rows[0]?.state).toMatchObject({ state: { playing: false, activeDeviceId: null, positionMs: 15_000 } }))
    const last = await open('device-a-14')
    expect((await last.hello({ detached: true })).snapshot.state).toMatchObject({ playing: false, activeDeviceId: null, positionMs: 15_000 })
  })

  it('acks detaches and attaches past the rate limit rate_limited without applying them', async () => {
    const a = await device('device-a-17')
    // Detach and attach share one budget of ten; at one every two seconds, the rest stay limited.
    const replies = await Promise.all(Array.from({ length: 20 }, (_, index) => (index % 2 ? a.attach() : a.detach())))
    expect(replies.slice(0, 10).every((reply) => reply.ok)).toBe(true)
    const limited = replies.filter((reply) => !reply.ok)
    expect(limited.length).toBeGreaterThanOrEqual(8)
    expect(limited).toEqual(limited.map(() => ({ ok: false, error: 'rate_limited' })))
    // The device is where the last move that went through put it.
    const last = ok(replies.findLast((reply) => reply.ok)!)
    expect((await a.hello({ detached: true })).snapshot.scope).toEqual(last.snapshot.scope)
    expect(await storedRows()).toHaveLength(last.snapshot.scope?.type === 'device' ? 1 : 0)
  })

  it('keeps at most eight own sessions, making room from the one gone longest', async () => {
    const watcher = await device('device-w-15', { canPlay: false })
    const gone = await device('device-gone-15')
    ok(await gone.detach())
    await close(gone, watcher)
    time += 1000
    const later = await device('device-later-15')
    ok(await later.detach())
    await close(later, watcher)
    const connected: Peer[] = []
    for (let index = 0; index < 6; index += 1) {
      const peer = await device(`device-c${index}-15`)
      ok(await peer.detach())
      connected.push(peer)
    }
    // Eight stored, six connected: the next one drops the session gone longest.
    const seventh = await device('device-c6-15')
    ok(await seventh.detach())
    expect((await storedRows()).map((row) => row.deviceId)).not.toContain('device-gone-15')
    expect(await storedRows()).toHaveLength(8)
    const eighth = await device('device-c7-15')
    ok(await eighth.detach())
    expect((await storedRows()).map((row) => row.deviceId)).not.toContain('device-later-15')

    // Eight connected and detached: no room is made.
    const ninth = await device('device-c8-15')
    expect(await ninth.detach()).toEqual({ ok: false, error: 'too_many_detached' })
  })
})
