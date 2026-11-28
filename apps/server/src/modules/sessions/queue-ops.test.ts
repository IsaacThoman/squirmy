import type { AddressInfo } from 'node:net'
import { applyQueueOps } from '@squirmy/client-core'
import type {
  ClientToServerEvents, CommandAck, QueueSeed, ServerToClientEvents, SessionCommand, SessionHello, SessionHelloAck, SessionMoveAck, SessionQueue,
  SessionQueueOps, SessionSyncAck,
} from '@squirmy/contracts'
import type { FastifyInstance } from 'fastify'
import { io as connect, type Socket } from 'socket.io-client'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildApp } from '../../app.js'
import { db } from '../../database/client.js'
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
type QueueUpdate = { version: number; queueVersion: number; queue: SessionQueue }

async function eventually(check: () => void, timeoutMs = 5000): Promise<void> {
  const deadline = performance.now() + timeoutMs
  for (;;) {
    try {
      check()
      return
    } catch (error) {
      if (performance.now() > deadline) throw error
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

/** A raw socket for one device, logging the queue messages it receives in order, with their size on the wire. */
class Peer {
  readonly log: { event: 'session:queue' | 'session:queueOps' | 'session:state' | 'session:moved'; payload: unknown; bytes: number }[] = []
  private serial = 0

  constructor(readonly socket: Client, readonly deviceId: string) {
    for (const event of ['session:queue', 'session:queueOps', 'session:state', 'session:moved'] as const) {
      socket.on(event, (payload: unknown) => this.log.push({ event, payload, bytes: JSON.stringify(payload).length }))
    }
  }

  /** `ops`: says it accepts `queueOps`, as current clients do; without it, speaks like an older one. */
  hello(ops: boolean): Promise<SessionHelloAck> {
    const hello: SessionHello = { device: { id: this.deviceId, name: this.deviceId, kind: 'web' }, canPlay: true, detached: false }
    if (ops) hello.accepts = ['queueOps']
    return this.socket.emitWithAck('session:hello', hello)
  }

  send(command: SessionCommand): Promise<CommandAck> {
    return this.socket.emitWithAck('session:command', { commandId: `${this.socket.id}-${++this.serial}`, command })
  }

  detach(): Promise<SessionMoveAck> {
    return this.socket.emitWithAck('session:detach', {})
  }

  attach(bringQueue?: boolean): Promise<SessionMoveAck> {
    return this.socket.emitWithAck('session:attach', bringQueue === undefined ? {} : { bringQueue })
  }

  sync(): Promise<SessionSyncAck> {
    return this.socket.emitWithAck('session:sync', {})
  }

  events<T>(name: string): T[] {
    return this.log.filter(({ event }) => event === name).map(({ payload }) => payload as T)
  }

  clear(): void {
    this.log.length = 0
  }
}

describe('queue operations', () => {
  useTestDatabase()
  let app: FastifyInstance
  let url = ''
  const sockets: Client[] = []
  let album: Awaited<ReturnType<typeof createAlbum>>
  let user: { id: string; token: string }
  let time = 0

  beforeAll(async () => {
    app = await buildApp()
    await sessionsModule.realtime!(await startRealtime(app))
    await app.listen({ host: '127.0.0.1', port: 0 })
    url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`
    album = await createAlbum({ owned: true, tracks: [{ title: 'One', durationMs: 200_000 }, { title: 'Two', durationMs: 200_000 }, { title: 'Three', durationMs: 200_000 }] })
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

  async function device(deviceId: string, ops = true): Promise<Peer> {
    const peer = await open(deviceId)
    await peer.hello(ops)
    return peer
  }

  /** `count` seeds, cycling through the album's tracks: entries are per seed, so repeats make a long queue. */
  const seeds = (count: number): QueueSeed[] => Array.from({ length: count }, (_, i) => {
    const track = album.tracks[i % album.tracks.length]!
    return { trackId: track.recordingId, albumId: album.albumId, durationMs: 0 }
  })
  const ok = (reply: SessionMoveAck) => {
    if (!reply.ok) throw new Error(`refused: ${reply.error}`)
    return reply
  }

  it('says it can send operations', async () => {
    const a = await open('queue-ops-a-1')
    expect((await a.hello(true)).capabilities).toContain('queueOps')
  })

  it('sends a track end on a 10,000-entry queue in under a kilobyte, and the whole queue to an older client', async () => {
    const a = await device('queue-ops-a-2')
    const old = await device('queue-ops-old-2', false)
    expect((await a.send({ type: 'playTracks', tracks: seeds(5000), seed: 1 })).ok).toBe(true)
    expect((await a.send({ type: 'enqueue', tracks: seeds(5000), placement: 'last' })).ok).toBe(true)
    expect((await a.send({ type: 'enqueue', tracks: seeds(1), placement: 'last' })).ok).toBe(true)
    const before = await getSnapshot(user.id)
    expect(before.queue.queue).toHaveLength(10_000)
    await eventually(() => expect(old.events<QueueUpdate>('session:queue').at(-1)?.queueVersion).toBe(before.queueVersion))
    a.clear()
    old.clear()

    expect((await a.send({ type: 'trackEnded', entryId: before.state.current!.id })).ok).toBe(true)
    const after = await getSnapshot(user.id)
    await eventually(() => expect(a.events('session:state')).toHaveLength(1))
    await eventually(() => expect(old.events('session:state')).toHaveLength(1))

    // Operations, then the state, and no whole queue.
    expect(a.log.map(({ event }) => event)).toEqual(['session:queueOps', 'session:state'])
    const [update] = a.events<SessionQueueOps>('session:queueOps')
    expect(a.log[0]!.bytes).toBeLessThan(1024)
    expect(update).toMatchObject({ version: after.version, queueVersion: after.queueVersion, baseQueueVersion: before.queueVersion, scope: { type: 'shared' } })
    expect(applyQueueOps(before.queue, update!.ops, update!.lengths)).toEqual(after.queue)

    expect(old.log.map(({ event }) => event)).toEqual(['session:queue', 'session:state'])
    expect(old.events<QueueUpdate>('session:queue')[0]!.queue).toEqual(after.queue)
    expect(old.log[0]!.bytes).toBeGreaterThan(1_000_000)
  })

  it('sends the whole queue to everyone when the change is large', async () => {
    const a = await device('queue-ops-a-3')
    await a.send({ type: 'playTracks', tracks: seeds(10), seed: 1 })
    await eventually(() => expect(a.events('session:state')).toHaveLength(1))
    a.clear()
    await a.send({ type: 'playTracks', tracks: seeds(600), seed: 2 })
    await eventually(() => expect(a.events('session:state')).toHaveLength(1))
    expect(a.log.map(({ event }) => event)).toEqual(['session:queue', 'session:state'])
    expect(a.events<QueueUpdate>('session:queue')[0]!.queue).toEqual((await getSnapshot(user.id)).queue)
  })

  it('answers a sync with the whole session it is in, and refuses one before a hello or past the budget', async () => {
    const stranger = await open('queue-ops-s-4')
    expect(await stranger.sync()).toEqual({ ok: false, error: 'hello_required' })
    const a = await device('queue-ops-a-4')
    await a.send({ type: 'playTracks', tracks: seeds(3), seed: 1 })
    expect(await a.sync()).toEqual({ ok: true, snapshot: await getSnapshot(user.id) })
    const replies = await Promise.all(Array.from({ length: 5 }, () => a.sync()))
    expect(replies.filter((reply) => !reply.ok)).toEqual([{ ok: false, error: 'rate_limited' }])
  })

  it('keeps operations to each session through detach, attach and session:moved', async () => {
    const shared = await device('queue-ops-shared-5')
    const x = await device('queue-ops-x-5')
    const xSecond = await device('queue-ops-x-5')
    await shared.send({ type: 'playTracks', tracks: seeds(20), seed: 1 })

    const detached = ok(await x.detach())
    expect(detached.snapshot.scope).toEqual({ type: 'device', deviceId: 'queue-ops-x-5' })
    await eventually(() => expect(xSecond.events('session:moved')).toHaveLength(1))
    for (const peer of [shared, x, xSecond]) peer.clear()

    // The own session's changes go to its device's sockets as operations of that session.
    const own = detached.snapshot
    await x.send({ type: 'removeFromQueue', entryId: own.queue.queue[0]!.id })
    await eventually(() => expect(xSecond.events('session:state')).toHaveLength(1))
    for (const peer of [x, xSecond]) {
      const [update] = peer.events<SessionQueueOps>('session:queueOps')
      expect(update).toMatchObject({ scope: { type: 'device', deviceId: 'queue-ops-x-5' }, baseQueueVersion: own.queueVersion })
      expect(applyQueueOps(own.queue, update!.ops, update!.lengths)!.queue).toEqual(own.queue.queue.slice(1))
    }
    expect(shared.log).toEqual([])

    // Back with the queue: the shared session's sockets follow, the device's other socket is moved there.
    const sharedBefore = await getSnapshot(user.id)
    const attached = ok(await x.attach(true))
    expect(attached.snapshot.scope).toEqual({ type: 'shared' })
    await eventually(() => expect(xSecond.events('session:moved')).toHaveLength(1))
    await eventually(() => expect(shared.events('session:state')).toHaveLength(1))
    const sharedAfter = await getSnapshot(user.id)
    const [change] = shared.log
    if (change!.event === 'session:queueOps') {
      const update = change!.payload as SessionQueueOps
      expect(update.baseQueueVersion).toBe(sharedBefore.queueVersion)
      expect(applyQueueOps(sharedBefore.queue, update.ops, update.lengths)).toEqual(sharedAfter.queue)
    } else {
      expect((change!.payload as QueueUpdate).queue).toEqual(sharedAfter.queue)
    }

    // The moved socket is in the shared session's operations room now.
    for (const peer of [shared, x, xSecond]) peer.clear()
    await shared.send({ type: 'next' })
    const latest = await getSnapshot(user.id)
    for (const peer of [shared, x, xSecond]) {
      await eventually(() => expect(peer.events('session:state')).toHaveLength(1))
      const [update] = peer.events<SessionQueueOps>('session:queueOps')
      expect(update).toMatchObject({ scope: { type: 'shared' }, baseQueueVersion: sharedAfter.queueVersion })
      expect(applyQueueOps(sharedAfter.queue, update!.ops, update!.lengths)).toEqual(latest.queue)
    }
  })
})
