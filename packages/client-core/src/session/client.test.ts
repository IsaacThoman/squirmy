import type {
  AnySessionCommand,
  Session,
} from './reducer.js'
import type {
  CommandEnvelope,
  DeviceInfo,
  EngineReport,
  PlaybackDescriptor,
  QueueEntry,
  QueueSeed,
  ServerToClientEvents,
  SessionAttach,
  SessionCommand,
  SessionHello,
  SessionHelloAck,
  SignalPath,
  SignalReport,
} from '@squirmy/contracts'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FakeEngine } from '../engine.js'
import { ApiError } from '../api/client.js'
import { type SavedSession, SessionClient, type SessionPlayer } from './client.js'
import { createInitialSession, positionAt, queueChanged, reduceSession, splitSession } from './reducer.js'
import { bringSession, forkSession } from './scope.js'
import type { AckCallback, AckEvent, AckPayload, AckReply, SessionTransport } from './transport.js'

const PHONE = 'phone-0001'
const WEB = 'web-00001'
const SERVER_OFFSET = 5000
const track = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const seeds = (...ns: number[]): QueueSeed[] => ns.map(n => ({ trackId: track(n), albumId: null, durationMs: 200_000 }))
const trackOf = (entry: QueueEntry | null | undefined) => entry && Number(entry.trackId.slice(-12))

/** A session the fake server holds: the shared one, or a detached device's own. */
type Held = { session: Session; version: number; queueVersion: number }

/**
 * The server side: the real reducer, versions, command de-duplication, ordered replies.
 * It is itself the shared session; `own` holds the sessions of detached devices.
 */
class FakeServer implements Held {
  session = createInitialSession()
  version = 1
  queueVersion = 1
  /** Own sessions of detached devices, by device id. */
  readonly own = new Map<string, Held>()
  readonly transports = new Set<FakeTransport>()
  readonly commands: CommandEnvelope[] = []
  readonly reports: EngineReport[] = []
  readonly hellos: SessionHello[] = []
  readonly signals: SignalReport[] = []
  /** The last signal path passed on, as the real server keeps it. */
  signal: SignalPath | null = null
  readonly seen = new Set<string>()
  rejecting = false
  /** Answers as a server from before detaching: no capabilities, no scope, and the new events are never answered. */
  old = false
  /** Detaches and attaches but never answers, as when the answer comes too late. */
  silentMoves = false
  /** What a hello claiming a detached session the server does not hold is told. */
  ended: 'expired' | 'missing' = 'missing'
  private serial = 0

  now(): number {
    return Date.now() + SERVER_OFFSET
  }

  /** The session a device is in. */
  held(deviceId?: string): Held {
    return (deviceId !== undefined && this.own.get(deviceId)) || this
  }

  /** Applies a command as if another device (or the server itself) sent it; to the shared session unless told otherwise. */
  apply(command: AnySessionCommand, deviceId?: string, commandId = `server-${(this.serial += 1)}`, held: Held = this, now = this.now()): void {
    this.replace(held, reduceSession(held.session, { command, now, commandId, deviceId }))
  }

  /** Makes `next` the session and tells the sockets in it. */
  private replace(held: Held, next: Session): void {
    const previous = held.session
    if (next === previous) return
    held.session = next
    held.version += 1
    const queue = queueChanged(previous, next)
    if (queue) held.queueVersion += 1
    const halves = splitSession(next)
    for (const transport of this.transports) {
      if (this.held(transport.deviceId) !== held) continue
      if (queue) transport.push('session:queue', { version: held.version, queueVersion: held.queueVersion, queue: halves.queue })
      transport.push('session:state', { version: held.version, state: halves.state })
    }
  }

  /**
   * As the server does after failures in a row: tells the sockets why with
   * `playback.unavailable` (`eventFirst`, as it does now, or after the state as it used to),
   * and pauses on the current entry marked failed.
   */
  pauseOnFailure(reason: string | null, eventFirst = true, kind?: 'outage' | 'failures' | 'exhausted'): void {
    const trackId = this.session.current!.trackId
    const tell = () => {
      for (const transport of this.transports) transport.push('event', { type: 'playback.unavailable', trackId, reason, ...(kind ? { kind } : {}) })
    }
    if (eventFirst) tell()
    const paused = reduceSession(this.session, { command: { type: 'pause' }, now: this.now(), commandId: `server-${(this.serial += 1)}` })
    this.replace(this, { ...paused, current: { ...paused.current!, state: 'failed' } })
    if (!eventFirst) tell()
  }

  devices(): DeviceInfo[] {
    return [...new Set([...this.transports].flatMap(transport => transport.deviceId ?? []))].map((id) => {
      const own = this.own.get(id)?.session
      return {
        id, name: id, kind: 'other', canPlay: !own, isActive: this.session.activeDeviceId === id,
        ...(own ? { detached: { playing: own.playing, trackId: own.current?.trackId ?? null, albumId: own.current?.albumId ?? null } } : {}),
      }
    })
  }

  /** Everything a hello is answered with, for the session the device is in. */
  private greeting(deviceId: string): SessionHelloAck {
    const held = this.held(deviceId)
    const { state, queue } = splitSession(held.session)
    const snapshot = { version: held.version, queueVersion: held.queueVersion, state, queue }
    if (this.old) return { serverTime: this.now(), snapshot, devices: this.devices() }
    const scope = held === this ? { type: 'shared' as const } : { type: 'device' as const, deviceId }
    const signal = this.signal && this.signal.entryId === held.session.current?.id && this.signal.deviceId === held.session.activeDeviceId ? this.signal : null
    return { serverTime: this.now(), snapshot: { ...snapshot, scope }, devices: this.devices(), capabilities: ['detach', 'signal', 'sleepTimer'], ...(signal ? { signal } : {}) }
  }

  /** As the server: keeps the active device's report about the current entry and passes it on. */
  receiveSignal(transport: FakeTransport, report: SignalReport): void {
    this.signals.push(report)
    const held = this.held(transport.deviceId)
    if (held.session.activeDeviceId !== transport.deviceId || held.session.current?.id !== report.entryId) return
    this.signal = { ...report, deviceId: transport.deviceId! }
    for (const other of this.transports) if (this.held(other.deviceId) === held) other.push('session:signal', this.signal)
  }

  /** Tells the device's other sockets that it changed session, and everyone the new device list. */
  private moved(transport: FakeTransport): void {
    for (const other of this.transports) {
      if (other !== transport && other.deviceId === transport.deviceId) other.push('session:moved', this.greeting(transport.deviceId!))
      other.push('devices', this.devices())
    }
  }

  receive<E extends AckEvent>(transport: FakeTransport, event: E, payload: AckPayload<E>, reply: (value: AckReply<E>) => void): void {
    const send = reply as (value: unknown) => void
    if (event === 'session:hello') {
      const hello = payload as SessionHello
      this.hellos.push(hello)
      transport.deviceId = hello.device.id
      const lost = !this.old && hello.detached === true && !this.own.has(hello.device.id)
      send({ ...this.greeting(hello.device.id), ...(lost ? { detachedEnded: this.ended } : {}) })
    } else if (event === 'time:sync') {
      send({ clientTime: payload, serverTime: this.now() })
    } else if (event === 'session:detach' || event === 'session:attach') {
      // An older server has no such listener, so the request times out.
      if (this.old) return
      const deviceId = transport.deviceId!
      if (this.rejecting) return send({ ok: false, error: 'rejected' })
      const own = this.own.get(deviceId)
      if (event === 'session:detach' && !own) {
        this.own.set(deviceId, { session: forkSession(this.session, deviceId, this.now()), version: this.version, queueVersion: this.queueVersion })
        this.apply({ type: 'deviceLost', deviceId })
      } else if (event === 'session:attach' && own) {
        if ((payload as SessionAttach).bringQueue) {
          if (!own.session.current && !own.session.queue.length) return send({ ok: false, error: 'nothing_to_bring' })
          // The others hear of it before this device is one of them; its own answer is the ack.
          this.replace(this, bringSession(this.session, own.session, { now: this.now(), commandId: `server-${(this.serial += 1)}`, deviceId }))
        }
        this.own.delete(deviceId)
      }
      if (!this.silentMoves) send({ ok: true, ...this.greeting(deviceId) })
      this.moved(transport)
    } else {
      const envelope = payload as CommandEnvelope
      const held = this.held(transport.deviceId)
      this.commands.push(envelope)
      if (this.rejecting) return send({ ok: false, error: 'rejected' })
      if (this.seen.has(envelope.commandId)) return send({ ok: true, version: held.version })
      // As the real server: only the active device may end a track.
      if (envelope.command.type === 'trackEnded' && held.session.activeDeviceId !== transport.deviceId) {
        return send({ ok: false, error: 'not_active_device' })
      }
      this.seen.add(envelope.commandId)
      const before = held.session
      const next = reduceSession(before, { command: envelope.command, now: this.now(), commandId: envelope.commandId, deviceId: transport.deviceId })
      // The protocol acks before it broadcasts.
      send({ ok: true, version: next === before ? held.version : held.version + 1 })
      this.replace(held, next)
    }
  }
}

/** One socket: two ordered queues of messages, delivered only by `flush`. Disconnects lose what is in flight. */
class FakeTransport implements SessionTransport {
  connected = false
  deviceId: string | undefined
  private epoch = 0
  private toServer: (() => void)[] = []
  private toClient: (() => void)[] = []
  private readonly connectionListeners = new Set<(connected: boolean) => void>()
  private readonly listeners = new Map<string, Set<(update: never) => void>>()

  constructor(private readonly server: FakeServer) {}

  isConnected(): boolean {
    return this.connected
  }

  onConnectionChange(listener: (connected: boolean) => void): () => void {
    this.connectionListeners.add(listener)
    return () => this.connectionListeners.delete(listener)
  }

  request<E extends AckEvent>(event: E, payload: AckPayload<E>, timeoutMs: number, callback: AckCallback<E>): void {
    let done = false
    const timer = setTimeout(() => {
      if (!done) {
        done = true
        callback(new Error('timeout'))
      }
    }, timeoutMs)
    const epoch = this.epoch
    this.toServer.push(() => this.server.receive(this, event, payload, reply => {
      if (epoch !== this.epoch) return
      this.toClient.push(() => {
        if (done) return
        done = true
        clearTimeout(timer)
        callback(null, reply)
      })
    }))
  }

  report(report: EngineReport): void {
    this.toServer.push(() => this.server.reports.push(report))
  }

  signal(report: SignalReport): void {
    this.toServer.push(() => this.server.receiveSignal(this, report))
  }

  on<E extends keyof ServerToClientEvents>(event: E, listener: ServerToClientEvents[E]): () => void {
    const set = this.listeners.get(event) ?? new Set()
    this.listeners.set(event, set)
    set.add(listener as (update: never) => void)
    return () => set.delete(listener as (update: never) => void)
  }

  push<E extends keyof ServerToClientEvents>(event: E, update: Parameters<ServerToClientEvents[E]>[0]): void {
    if (!this.connected) return
    this.toClient.push(() => {
      for (const listener of this.listeners.get(event) ?? []) (listener as (value: typeof update) => void)(update)
    })
  }

  connect(): void {
    this.connected = true
    this.server.transports.add(this)
    for (const listener of this.connectionListeners) listener(true)
  }

  disconnect(): void {
    this.connected = false
    this.epoch += 1
    this.toServer = []
    this.toClient = []
    this.server.transports.delete(this)
    for (const listener of this.connectionListeners) listener(false)
  }

  /** Delivers client-to-server messages only. */
  flushToServer(): void {
    while (this.toServer.length) this.toServer.shift()!()
  }

  /** Delivers the next server-to-client message. */
  deliverOne(): void {
    this.toClient.shift()?.()
  }

  /** Delivers everything in both directions until quiet. */
  flush(): void {
    while (this.toServer.length || this.toClient.length) {
      if (this.toServer.length) this.toServer.shift()!()
      else this.toClient.shift()!()
    }
  }
}

function descriptor(entry: QueueEntry): PlaybackDescriptor {
  return {
    trackId: entry.trackId,
    albumId: entry.albumId,
    fileId: track(900),
    url: `/api/v1/stream/${entry.trackId}`,
    expiresAt: new Date(Date.now() + 12 * 3600_000).toISOString(),
    profile: 'original',
    transcoded: false,
    mime: 'audio/flac',
    codec: 'flac',
    lossless: true,
    bitrate: null,
    sampleRate: 44100,
    bitDepth: 16,
    durationMs: entry.durationMs,
    bytes: null,
    normalization: { trackGainDb: -6, albumGainDb: null, trackPeak: null, albumPeak: null },
  }
}

function setup({ canPlay = true, connect = true, restore, server = new FakeServer(), id = PHONE, onLoadError, systemVolume }: {
  canPlay?: boolean; connect?: boolean; restore?: SavedSession; server?: FakeServer; id?: string
  onLoadError?: SessionPlayer['onLoadError']; systemVolume?: boolean
} = {}) {
  const transport = new FakeTransport(server)
  const engine = new FakeEngine()
  engine.durationMs = 200_000
  const resolvePlayback = vi.fn(async (entry: QueueEntry) => descriptor(entry))
  const ended = vi.fn()
  const client = new SessionClient({
    transport,
    device: { id, name: 'Phone', kind: 'ios' },
    player: canPlay ? { engine, resolvePlayback, baseUrl: 'https://music.test', normalization: 'off', onLoadError, systemVolume } : undefined,
    restore,
    onDetachedEnded: ended,
  })
  client.start()
  const settle = async () => {
    for (let round = 0; round < 5; round += 1) {
      transport.flush()
      await vi.advanceTimersByTimeAsync(0)
    }
  }
  if (connect) transport.connect()
  const calls = (method: string) => engine.calls.filter(([name]) => name === method)
  return { server, transport, engine, client, resolvePlayback, settle, calls, ended }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(1_000_000)
})
afterEach(() => vi.useRealTimers())

describe('SessionClient sync', () => {
  it('says hello, adopts the server snapshot and estimates the clock offset', async () => {
    const { server, client, settle } = setup()
    server.apply({ type: 'setRepeat', value: 'all' })
    expect(client.getSnapshot().connection).toBe('connecting')
    await settle()
    expect(client.getSnapshot()).toMatchObject({ connection: 'online', session: { repeat: 'all' }, isActiveDevice: false })
    expect(client.serverNow() - Date.now()).toBe(SERVER_OFFSET)
    expect(client.getSnapshot().devices.map(device => device.id)).toEqual([PHONE])
  })

  it('applies commands optimistically and converges with the server', async () => {
    const { server, client, transport, settle } = setup({ canPlay: false })
    await settle()
    client.dispatch({ type: 'playTracks', tracks: seeds(1, 2, 3), seed: 1 })
    expect(trackOf(client.getSnapshot().session.current)).toBe(1)
    expect(server.session.current).toBeNull()
    transport.flush()
    expect(server.session.current!.id).toBe(client.getSnapshot().session.current!.id)
    expect(splitSession(server.session)).toEqual({ state: client.getSnapshot().session, queue: client.getSnapshot().queue })
  })

  it('rebases pending commands on top of other devices\' changes', async () => {
    const { server, client, transport, settle } = setup({ canPlay: false })
    server.apply({ type: 'playTracks', tracks: seeds(1, 2, 3), seed: 1 }, WEB)
    await settle()
    client.dispatch({ type: 'enqueue', tracks: seeds(9), placement: 'last' })
    server.apply({ type: 'setRepeat', value: 'one' }, WEB)
    transport.deliverOne()
    const snapshot = client.getSnapshot()
    expect(snapshot.session.repeat).toBe('one')
    expect(snapshot.queue.queue.map(trackOf)).toEqual([2, 3, 9])
    transport.flush()
    expect(client.getSnapshot().queue.queue.map(entry => entry.id)).toEqual(server.session.queue.map(entry => entry.id))
  })

  it('keeps an acked command applied until the state that includes it arrives, without applying it twice', async () => {
    const { server, client, transport, settle } = setup({ canPlay: false })
    server.apply({ type: 'playTracks', tracks: seeds(1, 2, 3, 4), seed: 1 }, WEB)
    await settle()
    client.dispatch({ type: 'next' })
    expect(trackOf(client.getSnapshot().session.current)).toBe(2)
    transport.flushToServer()
    transport.deliverOne() // the ack
    expect(trackOf(client.getSnapshot().session.current)).toBe(2)
    transport.flush() // queue and state at the acked version
    expect(trackOf(client.getSnapshot().session.current)).toBe(2)
    server.apply({ type: 'setAutoplay', value: false }, WEB)
    transport.flush()
    expect(trackOf(client.getSnapshot().session.current)).toBe(2)
  })

  it('drops a rejected command', async () => {
    const { server, client, transport, settle } = setup({ canPlay: false })
    await settle()
    server.rejecting = true
    client.dispatch({ type: 'setRepeat', value: 'all' })
    expect(client.getSnapshot().session.repeat).toBe('all')
    transport.flush()
    expect(client.getSnapshot().session.repeat).toBe('off')
  })

  it('drops a command whose ack times out while connected', async () => {
    const { client, settle } = setup({ canPlay: false })
    await settle()
    client.dispatch({ type: 'setRepeat', value: 'all' })
    await vi.advanceTimersByTimeAsync(10_000)
    expect(client.getSnapshot().session.repeat).toBe('off')
  })

  it('throws on an invalid command', () => {
    const { client } = setup({ canPlay: false })
    expect(() => client.dispatch({ type: 'seek', positionMs: -1 })).toThrow()
  })

  it('keeps commands made offline and sends them in order after reconnecting', async () => {
    const { server, client, transport, settle } = setup({ canPlay: false })
    server.apply({ type: 'playTracks', tracks: seeds(1, 2), seed: 1 }, WEB)
    await settle()
    transport.disconnect()
    expect(client.getSnapshot().connection).toBe('offline')
    client.dispatch({ type: 'enqueue', tracks: seeds(7), placement: 'last' })
    client.dispatch({ type: 'setRepeat', value: 'all' })
    await vi.advanceTimersByTimeAsync(30_000)
    expect(client.getSnapshot().queue.queue.map(trackOf)).toEqual([2, 7])
    expect(server.commands).toEqual([])
    transport.connect()
    await settle()
    expect(server.commands.map(envelope => envelope.command.type)).toEqual(['enqueue', 'setRepeat'])
    expect(server.session.queue.map(trackOf)).toEqual([2, 7])
    expect(client.getSnapshot().session.repeat).toBe('all')
  })

  it('re-sends a command whose ack was lost, and the server applies it once', async () => {
    const { server, client, transport, settle } = setup({ canPlay: false })
    await settle()
    client.dispatch({ type: 'enqueue', tracks: seeds(5), placement: 'last' })
    transport.flushToServer()
    transport.disconnect()
    transport.connect()
    await settle()
    expect(server.commands).toHaveLength(2)
    expect(server.session.queue.map(trackOf)).toEqual([5])
    expect(client.getSnapshot().queue.queue.map(trackOf)).toEqual([5])
  })

  it('stays stable between changes and notifies subscribers', async () => {
    const { server, client, transport, settle } = setup({ canPlay: false })
    const listener = vi.fn()
    client.subscribe(listener)
    await settle()
    const snapshot = client.getSnapshot()
    expect(client.getSnapshot()).toBe(snapshot)
    listener.mockClear()
    server.apply({ type: 'setRepeat', value: 'one' }, WEB)
    transport.flush()
    expect(listener).toHaveBeenCalledOnce()
    const next = client.getSnapshot()
    expect(next).not.toBe(snapshot)
    expect(next.queue).toBe(snapshot.queue)
  })
  it('renames the device with a fresh hello and keeps its commands', async () => {
    const { server, client, transport, settle } = setup({ canPlay: false })
    const names: string[] = []
    const receive = server.receive.bind(server)
    server.receive = (from, event, payload, reply) => {
      if (event === 'session:hello') names.push((payload as AckPayload<'session:hello'>).device.name)
      receive(from, event, payload, reply)
    }
    await settle()
    client.dispatch({ type: 'setRepeat', value: 'one' })
    client.rename('Kitchen')
    client.rename('Kitchen')
    await settle()
    expect(names).toEqual(['Phone', 'Kitchen'])
    expect(client.getSnapshot()).toMatchObject({ connection: 'online', session: { repeat: 'one' } })
    expect(server.session.repeat).toBe('one')
    transport.disconnect()
    transport.connect()
    await settle()
    expect(names).toEqual(['Phone', 'Kitchen', 'Kitchen'])
  })
})

describe('SessionClient away', () => {
  /** The server's list as it is now, to every socket, as the real one sends it when a device comes or goes. */
  function relist(server: FakeServer) {
    for (const transport of server.transports) transport.push('devices', server.devices())
  }

  /** A phone that only controls, and a web player playing the shared session. */
  async function remoteAndPlayer() {
    const phone = setup({ canPlay: false })
    await phone.settle()
    const web = setup({ server: phone.server, id: WEB })
    await web.settle()
    relist(phone.server)
    web.client.dispatch({ type: 'playTracks', tracks: seeds(1, 2), seed: 1 })
    await web.settle()
    await phone.settle()
    return { phone, web, server: phone.server }
  }

  it('names the active device while the live list leaves it out, and forgets it once the session lets go', async () => {
    const { phone, web, server } = await remoteAndPlayer()
    expect(phone.client.getSnapshot()).toMatchObject({ away: null, session: { activeDeviceId: WEB } })

    web.transport.disconnect()
    relist(server)
    await phone.settle()
    expect(phone.client.getSnapshot().devices.map(device => device.id)).toEqual([PHONE])
    expect(phone.client.getSnapshot().away).toEqual({ id: WEB, device: expect.objectContaining({ id: WEB, name: WEB }) })
    // Kept while nothing about it changes, so screens reading it do not re-render.
    const away = phone.client.getSnapshot().away
    relist(server)
    await phone.settle()
    expect(phone.client.getSnapshot().away).toBe(away)

    // The grace period ran out.
    server.apply({ type: 'deviceLost', deviceId: WEB })
    await phone.settle()
    expect(phone.client.getSnapshot()).toMatchObject({ away: null, session: { activeDeviceId: null, playing: false } })
  })

  it('stops calling the device away when it comes back', async () => {
    const { phone, web, server } = await remoteAndPlayer()
    web.transport.disconnect()
    relist(server)
    await phone.settle()
    expect(phone.client.getSnapshot().away?.id).toBe(WEB)

    web.transport.connect()
    await web.settle()
    relist(server)
    await phone.settle()
    expect(phone.client.getSnapshot()).toMatchObject({ away: null, session: { activeDeviceId: WEB } })
  })

  it('has no name for a device it never saw listed, and says nothing while offline', async () => {
    const { phone, web, server } = await remoteAndPlayer()
    web.transport.disconnect()
    const late = setup({ server, id: 'tablet-0001', canPlay: false })
    await late.settle()
    expect(late.client.getSnapshot().away).toEqual({ id: WEB, device: null })

    phone.transport.disconnect()
    expect(phone.client.getSnapshot()).toMatchObject({ connection: 'offline', away: null })
  })

  it('never calls this device away', async () => {
    const { client, settle, server } = setup()
    await settle()
    client.dispatch({ type: 'playTracks', tracks: seeds(1), seed: 1 })
    await settle()
    for (const transport of server.transports) transport.push('devices', [])
    await settle()
    expect(client.getSnapshot()).toMatchObject({ isActiveDevice: true, away: null })
  })
})

describe('SessionClient outage', () => {
  const REASON = 'The server can’t fetch music on demand right now.'

  async function paused(eventFirst: boolean) {
    const context = setup({ canPlay: false })
    await context.settle()
    context.server.apply({ type: 'playTracks', tracks: seeds(1, 2, 3), seed: 1 })
    await context.settle()
    const seen: { playing: boolean; outage: unknown }[] = []
    context.client.subscribe(() => {
      const { session, outage } = context.client.getSnapshot()
      seen.push({ playing: session.playing, outage })
    })
    context.server.pauseOnFailure(REASON, eventFirst)
    await context.settle()
    return { ...context, seen }
  }

  it('shows the pause and its reason in the same snapshot', async () => {
    const { client, seen } = await paused(true)
    // Told before the pause arrived, the outage waited for it.
    expect(seen).toEqual([{ playing: false, outage: { trackId: track(1), kind: 'outage', reason: REASON } }])
    expect(client.getSnapshot().outage).toEqual({ trackId: track(1), kind: 'outage', reason: REASON })
  })

  it('takes a reason that comes after the pause, as from an older server', async () => {
    const { seen } = await paused(false)
    expect(seen).toEqual([{ playing: false, outage: null }, { playing: false, outage: { trackId: track(1), kind: 'outage', reason: REASON } }])
  })

  it('forgets the outage once the session plays again, here or elsewhere', async () => {
    const here = await paused(true)
    here.client.dispatch({ type: 'play' })
    expect(here.client.getSnapshot().outage).toBeNull()
    await here.settle()
    expect(here.client.getSnapshot().outage).toBeNull()

    const elsewhere = await paused(true)
    elsewhere.server.apply({ type: 'next' })
    await elsewhere.settle()
    expect(elsewhere.client.getSnapshot().outage).toBeNull()
    // Paused on the failed entry again, without being told why, is not the outage again.
    elsewhere.server.apply({ type: 'previous' })
    elsewhere.server.apply({ type: 'pause' })
    elsewhere.server.apply({ type: 'setEntryState', trackId: track(1), state: 'failed' })
    await elsewhere.settle()
    expect(elsewhere.client.getSnapshot().outage).toBeNull()
  })

  it('keeps a missing reason as null and ignores other events', async () => {
    const { server, client, transport, settle } = setup({ canPlay: false })
    await settle()
    server.apply({ type: 'playTracks', tracks: seeds(1, 2), seed: 1 })
    await settle()
    const before = client.getSnapshot()
    transport.push('event', { type: 'import.updated', importId: track(50), status: 'done' })
    await settle()
    expect(client.getSnapshot()).toBe(before)
    server.pauseOnFailure(null)
    await settle()
    expect(client.getSnapshot().outage).toEqual({ trackId: track(1), kind: 'failures', reason: null })
  })

  it('takes the kind the server gives', async () => {
    const { server, client, settle } = setup({ canPlay: false })
    await settle()
    server.apply({ type: 'playTracks', tracks: seeds(1, 2), seed: 1 })
    await settle()
    server.pauseOnFailure(null, true, 'exhausted')
    await settle()
    expect(client.getSnapshot().outage).toEqual({ trackId: track(1), kind: 'exhausted', reason: null })
  })
})

describe('SessionClient failureOf', () => {
  it('remembers why tracks failed, as the server said, keeping the most recent', async () => {
    const { client, transport, settle } = setup({ canPlay: false })
    await settle()
    expect(client.failureOf(track(1))).toBeUndefined()
    transport.push('event', { type: 'playback.failed', trackId: track(1), failure: 'unavailable' })
    transport.push('event', { type: 'playback.failed', trackId: track(2), failure: 'error' })
    await settle()
    expect(client.failureOf(track(1))).toBe('unavailable')
    expect(client.failureOf(track(2))).toBe('error')
    // Told again, the newer reason wins and counts as recent.
    transport.push('event', { type: 'playback.failed', trackId: track(1), failure: 'outage' })
    for (let n = 3; n < 202; n += 1) transport.push('event', { type: 'playback.failed', trackId: track(n), failure: 'unavailable' })
    await settle()
    expect(client.failureOf(track(1))).toBe('outage')
    expect(client.failureOf(track(2))).toBeUndefined()
    expect(client.failureOf(track(201))).toBe('unavailable')
  })
})

describe('SessionClient engine', () => {
  async function playingHere(count = 3) {
    const context = setup()
    await context.settle()
    context.client.dispatch({ type: 'playTracks', tracks: seeds(...Array.from({ length: count }, (_, i) => i + 1)), seed: 1 })
    await context.settle()
    return context
  }

  it('claims the session, loads the current entry and preloads the next', async () => {
    const { client, engine, calls } = await playingHere()
    const { session, queue } = client.getSnapshot()
    expect(client.getSnapshot().isActiveDevice).toBe(true)
    expect(calls('load')).toEqual([['load', {
      entryId: session.current!.id,
      url: `https://music.test/api/v1/stream/${track(1)}`,
      startMs: 0,
      autoplay: true,
      gain: 1,
    }]])
    expect(engine.preloaded).toMatchObject({ entryId: queue.queue[0]!.id, url: `https://music.test/api/v1/stream/${track(2)}` })
  })

  it('does nothing with the engine while another device is active', async () => {
    const { server, engine, settle } = setup()
    server.apply({ type: 'playTracks', tracks: seeds(1, 2), seed: 1 }, WEB)
    await settle()
    expect(engine.calls).toEqual([])
  })

  it('follows pause, play and remote seeks', async () => {
    const { client, server, transport, engine, calls } = await playingHere()
    await vi.advanceTimersByTimeAsync(5000)
    client.dispatch({ type: 'pause' })
    expect(engine.getStatus().state).toBe('paused')
    client.dispatch({ type: 'play' })
    expect(engine.getStatus().state).toBe('playing')
    transport.flush()
    server.apply({ type: 'seek', positionMs: 90_000 }, WEB)
    transport.flush()
    expect(calls('seek').at(-1)).toEqual(['seek', 90_000])
    expect(engine.getStatus().positionMs).toBe(90_000)
  })

  it('seeks the engine on a local seek, however small', async () => {
    const { client, engine, calls } = await playingHere()
    await vi.advanceTimersByTimeAsync(2000)
    client.dispatch({ type: 'seek', positionMs: 2300 })
    expect(calls('seek')).toEqual([['seek', 2300]])
    expect(engine.getStatus().positionMs).toBe(2300)
  })

  it('ignores drift below the threshold', async () => {
    const { client, server, transport, calls } = await playingHere()
    await vi.advanceTimersByTimeAsync(5000)
    server.apply({ type: 'syncPosition', entryId: client.getSnapshot().session.current!.id, positionMs: 5400, stalled: false }, PHONE)
    transport.flush()
    expect(calls('seek')).toEqual([])
    server.apply({ type: 'syncPosition', entryId: client.getSnapshot().session.current!.id, positionMs: 9000, stalled: false }, PHONE)
    transport.flush()
    expect(calls('seek')).toEqual([['seek', 9000]])
  })

  it('advances by itself at the end of a track, gaplessly and without the server', async () => {
    const { client, transport, server, engine, calls, settle } = await playingHere()
    const second = client.getSnapshot().queue.queue[0]!
    transport.disconnect()
    engine.finish()
    expect(client.getSnapshot().session.current).toEqual(second)
    expect(engine.getStatus()).toMatchObject({ entryId: second.id, state: 'playing' })
    expect(calls('load')).toHaveLength(1)
    await settle()
    expect(engine.preloaded?.entryId).toBe(client.getSnapshot().queue.queue[0]!.id)
    transport.connect()
    await settle()
    // The engine's position follows the replayed end, which the server anchors on arrival.
    expect(server.commands.map(envelope => envelope.command.type)).toEqual(['playTracks', 'trackEnded', 'seek'])
    expect(server.session.current!.id).toBe(second.id)
  })

  it('preloads the restarted entry under repeat one, with the id the server will allocate', async () => {
    const { client, transport, server, engine, calls, settle } = await playingHere()
    client.dispatch({ type: 'setRepeat', value: 'one' })
    await settle()
    const preloaded = engine.preloaded!
    expect(preloaded.url).toContain(track(1))
    engine.finish()
    expect(client.getSnapshot().session.current!.id).toBe(preloaded.entryId)
    expect(calls('load')).toHaveLength(1)
    transport.flush()
    expect(server.session.current!.id).toBe(preloaded.entryId)
  })

  it('stops at the end of the queue and restarts on play', async () => {
    const { client, engine, calls, settle } = await playingHere(1)
    client.dispatch({ type: 'setAutoplay', value: false })
    await settle()
    engine.finish()
    expect(client.getSnapshot().session).toMatchObject({ playing: false, positionMs: 200_000 })
    expect(engine.getStatus().state).toBe('ended')
    client.dispatch({ type: 'play' })
    expect(calls('seek').at(-1)).toEqual(['seek', 0])
    expect(engine.getStatus()).toMatchObject({ state: 'playing', positionMs: 0 })
  })

  it('retries a failed entry when asked to play again or to seek, not on its own', async () => {
    const { client, engine, resolvePlayback, calls, settle } = await playingHere()
    engine.fail('unreachable')
    await settle()
    expect(calls('load')).toHaveLength(1)
    client.dispatch({ type: 'pause' })
    client.dispatch({ type: 'play' })
    await settle()
    expect(calls('load')).toHaveLength(2)
    expect(resolvePlayback).toHaveBeenCalledTimes(3)
    expect(engine.getStatus().state).toBe('playing')
    engine.fail('unreachable')
    client.dispatch({ type: 'seek', positionMs: 30_000 })
    await settle()
    expect(calls('load').at(-1)).toMatchObject(['load', { startMs: 30_000, autoplay: true }])
  })

  it('gives up on an entry the server refuses: reports it, stops the audio and tells the caller', async () => {
    const onLoadError = vi.fn()
    const context = setup({ onLoadError })
    const { client, engine, resolvePlayback, server, settle } = context
    const refused = new ApiError(404, 'not_available', 'Not available')
    resolvePlayback.mockImplementation(async entry => {
      if (entry.trackId === track(2)) throw refused
      return descriptor(entry)
    })
    await settle()
    client.dispatch({ type: 'playTracks', tracks: seeds(1, 2, 3), seed: 1 })
    await settle()
    client.dispatch({ type: 'next' })
    await settle()
    const current = client.getSnapshot().session.current!
    expect(trackOf(current)).toBe(2)
    expect(onLoadError).toHaveBeenCalledTimes(1)
    expect(onLoadError).toHaveBeenCalledWith(current, refused, false)
    // The first track must not go on playing under the second one's title.
    expect(engine.getStatus().state).toBe('idle')
    expect(server.reports.at(-1)).toMatchObject({ entryId: current.id, status: 'error' })
    const asked = resolvePlayback.mock.calls.filter(([entry]) => entry.trackId === track(2)).length
    await vi.advanceTimersByTimeAsync(30_000)
    await settle()
    expect(resolvePlayback.mock.calls.filter(([entry]) => entry.trackId === track(2))).toHaveLength(asked)
    expect(onLoadError).toHaveBeenCalledTimes(1)
    // Play asks again.
    client.dispatch({ type: 'pause' })
    client.dispatch({ type: 'play' })
    await settle()
    expect(resolvePlayback.mock.calls.filter(([entry]) => entry.trackId === track(2))).toHaveLength(asked + 1)
  })

  it('starts an entry that just became current at 0, though resolving it took a moment', async () => {
    const { client, resolvePlayback, settle, calls } = await playingHere()
    resolvePlayback.mockImplementation(async entry => {
      await new Promise(resolve => setTimeout(resolve, 150))
      return descriptor(entry)
    })
    client.forgetPlayback()
    client.dispatch({ type: 'next' })
    await vi.advanceTimersByTimeAsync(200)
    await settle()
    expect(calls('load').at(-1)?.[1]).toMatchObject({ entryId: client.getSnapshot().session.current!.id, startMs: 0 })
  })

  it('still starts a restored entry where it was', async () => {
    const { client, engine, calls, settle } = await playingHere()
    client.dispatch({ type: 'seek', positionMs: 42_000 })
    engine.stop()
    client.dispatch({ type: 'next' })
    client.dispatch({ type: 'seek', positionMs: 42_000 })
    await settle()
    expect(calls('load').at(-1)?.[1]).toMatchObject({ startMs: 42_000 })
  })

  it('does not ask again for a preload the server refused on every session change', async () => {
    const context = setup()
    const { client, resolvePlayback, settle } = context
    resolvePlayback.mockImplementation(async entry => {
      if (entry.trackId === track(2)) throw new ApiError(403, 'forbidden', 'Not for you')
      return descriptor(entry)
    })
    await settle()
    client.dispatch({ type: 'playTracks', tracks: seeds(1, 2, 3), seed: 1 })
    await settle()
    const asked = () => resolvePlayback.mock.calls.filter(([entry]) => entry.trackId === track(2)).length
    expect(asked()).toBe(1)
    client.dispatch({ type: 'setVolume', deviceId: PHONE, value: 0.5 })
    client.dispatch({ type: 'seek', positionMs: 10_000 })
    client.dispatch({ type: 'pause' })
    client.dispatch({ type: 'play' })
    await settle()
    expect(asked()).toBe(1)
    // Where it plays from changed: worth asking again.
    client.forgetPlayback()
    await settle()
    expect(asked()).toBe(2)
  })

  it('retries an entry it cannot reach, reporting a stall meanwhile', async () => {
    const onLoadError = vi.fn()
    const context = setup({ onLoadError })
    const { client, engine, resolvePlayback, server, settle } = context
    let failures = 2
    resolvePlayback.mockImplementation(async entry => {
      if (entry.trackId === track(2) && failures > 0) {
        failures -= 1
        throw new ApiError(0, 'network_error', 'Network request failed')
      }
      return descriptor(entry)
    })
    await settle()
    client.dispatch({ type: 'playTracks', tracks: seeds(1, 2, 3), seed: 1 })
    await settle()
    // The preload took the first failure; the load takes the second.
    client.dispatch({ type: 'next' })
    await settle()
    const current = client.getSnapshot().session.current!
    expect(onLoadError).toHaveBeenCalledWith(current, expect.any(ApiError), true)
    expect(server.reports.at(-1)).toMatchObject({ entryId: current.id, status: 'buffering' })
    await vi.advanceTimersByTimeAsync(3000)
    await settle()
    expect(engine.getStatus()).toMatchObject({ entryId: current.id, state: 'playing' })
    expect(server.reports.at(-1)).toMatchObject({ entryId: current.id, status: 'playing' })
  })

  it('starts a song it could not load offline from where it was asked, not from the time waited', async () => {
    const context = setup()
    const { client, engine, resolvePlayback, transport, settle, calls } = context
    let reachable = true
    resolvePlayback.mockImplementation(async entry => {
      if (!reachable && entry.trackId === track(3)) throw new ApiError(0, 'network_error', 'Network request failed')
      return descriptor(entry)
    })
    await settle()
    client.dispatch({ type: 'playTracks', tracks: seeds(1, 2, 3), seed: 1 })
    await settle()
    transport.disconnect()
    reachable = false
    client.dispatch({ type: 'next' })
    client.dispatch({ type: 'next' })
    await settle()
    const current = client.getSnapshot().session.current!
    expect(current.trackId).toBe(track(3))
    await vi.advanceTimersByTimeAsync(20_000)
    expect(engine.getStatus().entryId).not.toBe(current.id)
    reachable = true
    await vi.advanceTimersByTimeAsync(3000)
    await settle()
    expect(calls('load').at(-1)![1]).toMatchObject({ entryId: current.id, startMs: 0 })
  })

  it('stops the engine when another device takes over', async () => {
    const { server, transport, client, engine } = await playingHere()
    server.apply({ type: 'transfer', deviceId: WEB }, WEB)
    transport.flush()
    expect(client.getSnapshot().isActiveDevice).toBe(false)
    expect(engine.getStatus().state).toBe('idle')
  })

  it('on reconnect after a takeover, drops pending playback commands but keeps queue edits', async () => {
    const { server, transport, client, engine, settle } = await playingHere()
    transport.disconnect()
    client.dispatch({ type: 'pause' })
    client.dispatch({ type: 'enqueue', tracks: seeds(8), placement: 'last' })
    server.apply({ type: 'transfer', deviceId: WEB }, WEB)
    transport.connect()
    await settle()
    expect(server.commands.map(envelope => envelope.command.type)).toEqual(['playTracks', 'enqueue'])
    expect(server.session).toMatchObject({ playing: true, activeDeviceId: WEB })
    expect(client.getSnapshot()).toMatchObject({ isActiveDevice: false, session: { playing: true } })
    expect(engine.getStatus().state).toBe('idle')
  })

  it('reclaims the session at the engine position when the server gave up on it', async () => {
    const { server, transport, client, engine, calls, settle } = await playingHere()
    transport.disconnect()
    await vi.advanceTimersByTimeAsync(25_000)
    server.apply({ type: 'deviceLost', deviceId: PHONE })
    await vi.advanceTimersByTimeAsync(10_000)
    expect(engine.getStatus().state).toBe('playing')
    transport.connect()
    await settle()
    expect(server.session).toMatchObject({ activeDeviceId: PHONE, playing: true })
    expect(positionAt(server.session, server.now())).toBe(35_000)
    expect(client.getSnapshot().isActiveDevice).toBe(true)
    expect(engine.getStatus()).toMatchObject({ state: 'playing', positionMs: 35_000 })
    expect(calls('stop')).toEqual([])
  })

  it('reclaims the session when the server gave up on it while a song another device chose was still loading', async () => {
    const { server, transport, client, engine, calls, settle } = await playingHere()
    engine.holdLoads = true
    server.apply({ type: 'next' }, WEB)
    transport.flush()
    await settle()
    expect(engine.getStatus()).toMatchObject({ entryId: client.getSnapshot().session.current!.id, state: 'loading' })
    transport.disconnect()
    await vi.advanceTimersByTimeAsync(25_000)
    server.apply({ type: 'deviceLost', deviceId: PHONE })
    transport.connect()
    await settle()
    expect(server.session).toMatchObject({ activeDeviceId: PHONE, playing: true })
    expect(trackOf(server.session.current)).toBe(2)
    expect(client.getSnapshot()).toMatchObject({ isActiveDevice: true, session: { playing: true } })
    engine.ready()
    expect(engine.getStatus().state).toBe('playing')
    expect(calls('stop')).toEqual([])
  })

  it('keeps the tracks it ended offline after the server gave up on it', async () => {
    const { server, transport, client, engine, settle } = await playingHere(4)
    transport.disconnect()
    await vi.advanceTimersByTimeAsync(25_000)
    server.apply({ type: 'deviceLost', deviceId: PHONE })
    engine.finish()
    await vi.advanceTimersByTimeAsync(0)
    engine.finish()
    await vi.advanceTimersByTimeAsync(0)
    client.dispatch({ type: 'pause' })
    await vi.advanceTimersByTimeAsync(5_000)
    expect(trackOf(client.getSnapshot().session.current)).toBe(3)
    transport.connect()
    await settle()
    expect(trackOf(server.session.current)).toBe(3)
    expect(server.session).toMatchObject({ activeDeviceId: PHONE, playing: false })
    expect(trackOf(client.getSnapshot().session.current)).toBe(3)
    expect(client.getSnapshot().session.playing).toBe(false)
  })

  it('keeps the music where it is after commands made during a short disconnect', async () => {
    const { server, transport, client, engine, calls, settle } = await playingHere()
    transport.disconnect()
    client.dispatch({ type: 'next' })
    await settle()
    await vi.advanceTimersByTimeAsync(30_000)
    const seeks = calls('seek').length
    transport.connect()
    await settle()
    expect(trackOf(server.session.current)).toBe(2)
    expect(positionAt(server.session, server.now())).toBe(30_000)
    expect(engine.getStatus().positionMs).toBe(30_000)
    expect(calls('seek').length).toBe(seeks)
  })

  it('leaves the session alone on reconnect when it was paused here and nothing ended', async () => {
    const { server, transport, client, settle } = await playingHere()
    client.dispatch({ type: 'pause' })
    await settle()
    transport.disconnect()
    server.apply({ type: 'deviceLost', deviceId: PHONE })
    transport.connect()
    await settle()
    expect(server.session.activeDeviceId).toBeNull()
    expect(client.getSnapshot().isActiveDevice).toBe(false)
  })

  it('saves and restores the session with its unsent commands, paused where it was', async () => {
    const first = await playingHere(3)
    await vi.advanceTimersByTimeAsync(40_000)
    first.transport.disconnect()
    const lostAt = first.server.now()
    first.client.dispatch({ type: 'next' })
    await vi.advanceTimersByTimeAsync(20_000)
    const saved = JSON.parse(JSON.stringify(first.client.save())) as SavedSession
    first.client.dispose()

    const { server, transport, client, calls, settle } = setup({ restore: saved, connect: false, server: first.server })
    expect(client.getSnapshot()).toMatchObject({ isActiveDevice: true, session: { playing: false } })
    expect(trackOf(client.getSnapshot().session.current)).toBe(2)
    expect(client.getPositionMs()).toBe(20_000)
    await settle()
    expect(calls('load')[0]![1]).toMatchObject({ startMs: 20_000, autoplay: false })

    // As the server does, as of when the device went away: before the save, made offline.
    server.apply({ type: 'deviceLost', deviceId: PHONE }, undefined, undefined, server, lostAt)
    transport.connect()
    await settle()
    expect(trackOf(server.session.current)).toBe(2)
    expect(server.session).toMatchObject({ playing: false, positionMs: 20_000 })
  })

  it('does not rewind a session the server paused after the save when this device went away', async () => {
    const first = await playingHere(3)
    await vi.advanceTimersByTimeAsync(10_000)
    const saved = JSON.parse(JSON.stringify(first.client.save())) as SavedSession
    // The app goes on playing for 15 s after its last save, then is killed.
    await vi.advanceTimersByTimeAsync(15_000)
    first.transport.disconnect()
    first.client.dispose()
    first.server.apply({ type: 'deviceLost', deviceId: PHONE })
    const paused = first.server.session
    expect(paused.positionMs).toBe(25_000)

    const { server, transport, client, settle } = setup({ restore: saved, connect: false, server: first.server })
    expect(client.getSnapshot().session).toMatchObject({ playing: false, positionMs: 10_000 })
    transport.connect()
    await settle()
    expect(server.session).toBe(paused)
    expect(client.getSnapshot().session).toMatchObject({ playing: false, positionMs: 25_000, activeDeviceId: null })
    expect(client.save().pending).toEqual([])
  })

  it('drops a saved command that is no longer valid, keeping the rest', async () => {
    const { client } = setup({ connect: false })
    client.dispatch({ type: 'enqueue', tracks: seeds(1), placement: 'last' })
    const saved = client.save()
    const broken = { ...saved.pending[0]!, commandId: 'broken', command: { type: 'enqueue', tracks: 'nope' } as unknown as SessionCommand }
    const restored = new SessionClient({
      transport: new FakeTransport(new FakeServer()),
      device: { id: PHONE, name: 'Phone', kind: 'ios' },
      restore: { ...saved, pending: [broken, ...saved.pending] },
    })
    expect(restored.save().pending.map(pending => pending.commandId)).toEqual([saved.pending[0]!.commandId])
    expect(trackOf(restored.getSnapshot().queue.queue[0])).toBe(1)
  })

  it('restores a session another device plays as it was', async () => {
    const { server, client, settle } = setup()
    server.apply({ type: 'playTracks', tracks: seeds(1, 2), seed: 1 }, WEB)
    await settle()
    const saved = client.save()
    const restored = new SessionClient({ transport: new FakeTransport(server), device: { id: PHONE, name: 'Phone', kind: 'ios' }, restore: saved })
    expect(restored.getSnapshot()).toMatchObject({ isActiveDevice: false, session: { playing: true, activeDeviceId: WEB } })
    expect(restored.save().pending).toEqual([])
  })

  it('resolves entries again after forgetting descriptors', async () => {
    const { client, resolvePlayback } = await playingHere()
    const count = resolvePlayback.mock.calls.length
    client.forgetPlayback()
    await vi.advanceTimersByTimeAsync(0)
    expect(resolvePlayback.mock.calls.length).toBe(count + 1)
  })

  it('keeps the gain of what plays when descriptors are forgotten', async () => {
    const { client, engine } = await playingHere()
    client.setNormalization('track')
    const gain = 10 ** (-6 / 20)
    expect(engine.loaded!.gain).toBeCloseTo(gain)
    client.forgetPlayback()
    await vi.advanceTimersByTimeAsync(0)
    client.dispatch({ type: 'setRepeat', value: 'all' })
    expect(engine.loaded!.gain).toBeCloseTo(gain)
    // The preloaded entry takes over: its gain holds as well.
    engine.finish()
    client.forgetPlayback()
    client.dispatch({ type: 'setRepeat', value: 'off' })
    expect(trackOf(client.getSnapshot().session.current)).toBe(2)
    expect(engine.loaded!.gain).toBeCloseTo(gain)
  })

  it('forgets one track without aiming the preload of another again', async () => {
    const { client, engine, resolvePlayback, calls } = await playingHere()
    const resolved = resolvePlayback.mock.calls.length
    const preloads = calls('preload').length
    client.forgetPlayback(track(3))
    client.forgetPlayback(track(1))
    await vi.advanceTimersByTimeAsync(0)
    expect(resolvePlayback.mock.calls.length).toBe(resolved)
    expect(calls('preload').length).toBe(preloads)

    resolvePlayback.mockImplementation(async entry => ({ ...descriptor(entry), url: `file:///cache/${entry.trackId}.flac` }))
    client.forgetPlayback(track(2))
    await vi.advanceTimersByTimeAsync(0)
    expect(resolvePlayback.mock.calls.length).toBe(resolved + 1)
    expect(engine.preloaded).toMatchObject({ url: `file:///cache/${track(2)}.flac` })
    // Track 1 was forgotten too: it is resolved again when it next loads.
    client.dispatch({ type: 'next' })
    await vi.advanceTimersByTimeAsync(0)
    client.dispatch({ type: 'previous' })
    await vi.advanceTimersByTimeAsync(0)
    expect(calls('load').at(-1)![1]).toMatchObject({ url: `file:///cache/${track(1)}.flac` })
  })

  it('keeps the newer preload when an older resolve of the same entry answers late', async () => {
    const { client, engine, resolvePlayback } = await playingHere()
    let answerLate: (value: PlaybackDescriptor) => void = () => undefined
    resolvePlayback.mockImplementationOnce(entry => new Promise(resolve => { answerLate = () => resolve(descriptor(entry)) }))
    client.forgetPlayback(track(2))
    resolvePlayback.mockImplementation(async entry => ({ ...descriptor(entry), url: `file:///cache/${entry.trackId}.flac` }))
    client.forgetPlayback(track(2))
    await vi.advanceTimersByTimeAsync(0)
    answerLate(undefined as never)
    await vi.advanceTimersByTimeAsync(0)
    expect(engine.preloaded).toMatchObject({ url: `file:///cache/${track(2)}.flac` })
  })

  it('keeps a descriptor resolved while another track was forgotten', async () => {
    const { client, resolvePlayback } = await playingHere()
    let answer: () => void = () => undefined
    resolvePlayback.mockImplementationOnce(entry => new Promise(resolve => { answer = () => resolve(descriptor(entry)) }))
    client.forgetPlayback(track(2))
    client.forgetPlayback(track(3))
    answer()
    await vi.advanceTimersByTimeAsync(0)
    const resolved = resolvePlayback.mock.calls.length
    client.dispatch({ type: 'next' })
    await vi.advanceTimersByTimeAsync(0)
    expect(resolvePlayback.mock.calls.slice(resolved).map(([entry]) => entry.trackId)).not.toContain(track(2))
  })

  it('loads at the current position when the session is transferred here', async () => {
    const { server, transport, client, calls, settle } = setup()
    server.apply({ type: 'playTracks', tracks: seeds(1, 2), seed: 1 }, WEB)
    await settle()
    await vi.advanceTimersByTimeAsync(12_000)
    client.dispatch({ type: 'transfer', deviceId: PHONE })
    await settle()
    transport.flush()
    expect(calls('load')[0]![1]).toMatchObject({ startMs: 12_000, autoplay: true })
  })

  it('buffers the current entry ahead of a takeover, and reuses it when the session comes here', async () => {
    const { server, transport, client, engine, calls, settle, resolvePlayback } = setup()
    server.apply({ type: 'playTracks', tracks: seeds(1, 2), seed: 1 }, WEB)
    await settle()
    client.prepareTakeover()
    client.prepareTakeover()
    await settle()
    const current = client.getSnapshot().session.current!
    expect(engine.preloaded).toMatchObject({ entryId: current.id, url: `https://music.test/api/v1/stream/${track(1)}` })
    expect(calls('load')).toEqual([])
    expect(resolvePlayback).toHaveBeenCalledTimes(1)
    client.dispatch({ type: 'transfer', deviceId: PHONE })
    await settle()
    transport.flush()
    expect(calls('load')[0]![1]).toMatchObject({ entryId: current.id, autoplay: true })
    // Resolved once for the takeover; the load took the same answer.
    expect(resolvePlayback.mock.calls.filter(([entry]) => entry.id === current.id)).toHaveLength(1)
  })

  it('drops what it buffered for a takeover once another song plays elsewhere', async () => {
    const { server, transport, client, engine, settle } = setup()
    server.apply({ type: 'playTracks', tracks: seeds(1, 2), seed: 1 }, WEB)
    await settle()
    client.prepareTakeover()
    await settle()
    expect(engine.preloaded).not.toBeNull()
    server.apply({ type: 'next' }, WEB)
    transport.flush()
    await settle()
    expect(engine.preloaded).toBeNull()
    expect(client.getSnapshot().isActiveDevice).toBe(false)
  })

  it('prepares no takeover on the device that plays', async () => {
    const { client, engine, settle } = setup()
    await settle()
    client.dispatch({ type: 'playTracks', tracks: seeds(1, 2), seed: 1 })
    await settle()
    const preloaded = engine.preloaded
    client.prepareTakeover()
    await settle()
    expect(engine.preloaded).toBe(preloaded)
  })

  it('waits for a preparing entry, then loads it', async () => {
    const { server, transport, client, calls, settle } = setup()
    await settle()
    client.dispatch({ type: 'playTracks', tracks: [{ ...seeds(1)[0]!, state: 'preparing' }], seed: 1 })
    await settle()
    expect(calls('load')).toEqual([])
    server.apply({ type: 'setEntryState', trackId: track(1), state: 'ready' })
    transport.flush()
    await settle()
    expect(calls('load')).toHaveLength(1)
  })

  it('applies volume times normalization gain', async () => {
    const { client, engine, calls, settle } = await playingHere()
    client.dispatch({ type: 'setVolume', deviceId: PHONE, value: 0.5 })
    expect(calls('setGain').at(-1)).toEqual(['setGain', 0.5])
    client.setNormalization('track')
    expect(engine.loaded!.gain).toBeCloseTo(0.5 * 10 ** (-6 / 20))
    await settle()
  })

  it('leaves the volume out of the gain when the system applies it', async () => {
    const { client, engine, calls, settle } = setup({ systemVolume: true })
    await settle()
    client.dispatch({ type: 'playTracks', tracks: seeds(1, 2), seed: 1 })
    await settle()
    client.dispatch({ type: 'setVolume', deviceId: PHONE, value: 0.5 })
    expect(client.getSnapshot().session.volumes[PHONE]).toBe(0.5)
    expect(calls('setGain')).toEqual([])
    client.setNormalization('track')
    expect(engine.loaded!.gain).toBeCloseTo(10 ** (-6 / 20))
    await settle()
  })

  it('reports on status changes and every 10 seconds, only while active', async () => {
    const { server, transport, client, engine } = await playingHere()
    const entryId = client.getSnapshot().session.current!.id
    expect(server.reports.map(report => report.status)).toEqual(['buffering', 'playing'])
    engine.buffer()
    engine.resume()
    transport.flush()
    expect(server.reports.map(report => report.status)).toEqual(['buffering', 'playing', 'buffering', 'playing'])
    await vi.advanceTimersByTimeAsync(10_000)
    transport.flush()
    expect(server.reports.at(-1)).toMatchObject({ entryId, status: 'playing', at: Date.now() + SERVER_OFFSET })
    const count = server.reports.length
    server.apply({ type: 'transfer', deviceId: WEB }, WEB)
    transport.flush()
    await vi.advanceTimersByTimeAsync(30_000)
    transport.flush()
    expect(server.reports).toHaveLength(count)
  })

  it('reads the position from the engine while active', async () => {
    const { client, engine } = await playingHere()
    await vi.advanceTimersByTimeAsync(4000)
    engine.seek(1234)
    expect(client.getPositionMs()).toBe(1234)
  })

  it('stops the engine on dispose', async () => {
    const { client, engine } = await playingHere()
    client.dispose()
    expect(engine.getStatus().state).toBe('idle')
  })
})

describe('SessionClient signal path', () => {
  async function playingHere(server = new FakeServer()) {
    const context = setup({ server })
    await context.settle()
    context.client.dispatch({ type: 'playTracks', tracks: seeds(1, 2), seed: 1 })
    await context.settle()
    return context
  }

  it('shows what this device plays once it is loaded, and tells the server', async () => {
    const { client, server } = await playingHere()
    const { signal, session } = client.getSnapshot()
    expect(signal).toMatchObject({
      entryId: session.current!.id,
      deviceId: PHONE,
      source: { codec: 'flac', lossless: true, sampleRate: 44100, bitDepth: 16 },
      delivery: { profile: 'original', transcoded: false, reason: null, local: false },
      normalization: { mode: 'off', applied: null, gainDb: null },
    })
    expect(server.signals).toHaveLength(1)
    expect(server.signals[0]!.entryId).toBe(session.current!.id)
  })

  it('reports again when the next entry plays and when normalization changes, and not otherwise', async () => {
    const { client, server, engine, settle } = await playingHere()
    client.dispatch({ type: 'setVolume', deviceId: PHONE, value: 0.5 })
    await settle()
    expect(server.signals).toHaveLength(1)
    client.setNormalization('track')
    await settle()
    expect(server.signals.at(-1)!.normalization).toEqual({ mode: 'track', applied: 'track', gainDb: -6 })
    engine.finish()
    await settle()
    expect(server.signals.at(-1)!.entryId).toBe(client.getSnapshot().session.current!.id)
    expect(server.signals).toHaveLength(3)
  })

  it('reports again after a reconnect', async () => {
    const { server, transport, settle } = await playingHere()
    transport.disconnect()
    transport.connect()
    await settle()
    expect(server.signals).toHaveLength(2)
  })

  it('shows a remote device the active device\'s report, from the hello and as it changes', async () => {
    const phone = await playingHere()
    const web = setup({ server: phone.server, id: WEB, canPlay: false })
    await web.settle()
    expect(web.client.getSnapshot().signal).toMatchObject({ deviceId: PHONE, entryId: phone.client.getSnapshot().session.current!.id })
    phone.engine.finish()
    await phone.settle()
    await web.settle()
    expect(web.client.getSnapshot().signal?.entryId).toBe(web.client.getSnapshot().session.current!.id)
  })

  it('shows none while the report is about another entry or device', async () => {
    const phone = await playingHere()
    const web = setup({ server: phone.server, id: WEB, canPlay: false })
    await web.settle()
    phone.transport.disconnect()
    phone.server.apply({ type: 'next' }, WEB)
    await web.settle()
    expect(web.client.getSnapshot().signal).toBeNull()
  })

  it('sends nothing to a server without the capability', async () => {
    const server = new FakeServer()
    server.old = true
    const { client } = await playingHere(server)
    expect(client.getSnapshot().signal).not.toBeNull()
    expect(server.signals).toEqual([])
  })

  it('says when a stream is a local copy', async () => {
    const context = setup()
    context.resolvePlayback.mockImplementation(async entry => ({ ...descriptor(entry), url: 'file:///downloads/1.flac' }))
    await context.settle()
    context.client.dispatch({ type: 'playTracks', tracks: seeds(1), seed: 1 })
    await context.settle()
    expect(context.client.getSnapshot().signal?.delivery.local).toBe(true)
  })
})

describe('SessionClient detaching', () => {
  type Context = ReturnType<typeof setup>

  async function playingHere(count = 3, server = new FakeServer()) {
    const context = setup({ server })
    await context.settle()
    context.client.dispatch({ type: 'playTracks', tracks: seeds(...Array.from({ length: count }, (_, i) => i + 1)), seed: 1 })
    await context.settle()
    return context
  }

  /** Another device of the same user, connected to the same server. */
  async function another(server: FakeServer, id = WEB) {
    const context = setup({ server, id })
    await context.settle()
    return context
  }

  /** Lets every given client and the server finish talking. */
  async function quiet(...contexts: Context[]) {
    for (let round = 0; round < 3; round += 1) for (const context of contexts) await context.settle()
  }

  async function detached(context: Context, ...others: Context[]) {
    const done = context.client.detach()
    await quiet(context, ...others)
    expect(await done).toEqual({ ok: true })
  }

  it('offers detaching to a device that can play, once the server has said it can', async () => {
    const player = setup()
    expect(player.client.getSnapshot()).toMatchObject({ detached: false, canDetach: false })
    expect(await player.client.detach()).toEqual({ ok: false, error: 'offline' })
    await player.settle()
    expect(player.client.getSnapshot()).toMatchObject({ detached: false, canDetach: true })
    expect(player.server.hellos).toEqual([{ device: { id: PHONE, name: 'Phone', kind: 'ios' }, canPlay: true, detached: false }])
    expect(await player.client.attach()).toEqual({ ok: true })

    const remote = setup({ canPlay: false })
    await remote.settle()
    expect(remote.client.getSnapshot().canDetach).toBe(false)
    expect(await remote.client.detach()).toEqual({ ok: false, error: 'unsupported' })
  })

  it('hides detaching from a server that does not know it, and works as before', async () => {
    const server = new FakeServer()
    server.old = true
    const { client, transport, settle } = setup({ server })
    await settle()
    expect(client.getSnapshot()).toMatchObject({ connection: 'online', detached: false, canDetach: false })
    expect(await client.detach()).toEqual({ ok: false, error: 'unsupported' })
    client.dispatch({ type: 'playTracks', tracks: seeds(1, 2), seed: 1 })
    transport.flush()
    expect(trackOf(server.session.current)).toBe(1)
    expect(client.getSnapshot().isActiveDevice).toBe(true)
  })

  it('goes on playing in its own session when the playing device detaches, and leaves the shared one paused', async () => {
    const phone = await playingHere()
    const { server, client, engine, calls } = phone
    const web = await another(server)
    await vi.advanceTimersByTimeAsync(30_000)
    const entryId = client.getSnapshot().session.current!.id
    const loads = calls('load').length

    await detached(phone, web)
    expect(client.getSnapshot()).toMatchObject({ detached: true, isActiveDevice: true, session: { playing: true, activeDeviceId: PHONE, current: { id: entryId } } })
    expect(engine.getStatus()).toMatchObject({ state: 'playing', entryId, positionMs: 30_000 })
    expect(calls('load')).toHaveLength(loads)
    expect(calls('stop')).toEqual([])
    expect(calls('seek')).toEqual([])
    // The shared session stopped where it was, and the other device lists this one as playing on its own.
    expect(web.client.getSnapshot()).toMatchObject({ detached: false, isActiveDevice: false, session: { playing: false, activeDeviceId: null, positionMs: 30_000, current: { id: entryId } } })
    expect(web.client.getSnapshot().devices.find(device => device.id === PHONE)).toMatchObject({ canPlay: false, detached: { playing: true, trackId: track(1) } })

    // From here the two sessions go their own ways.
    client.dispatch({ type: 'next' })
    web.client.dispatch({ type: 'playTracks', tracks: seeds(7, 8), seed: 1 })
    await quiet(phone, web)
    expect(trackOf(server.own.get(PHONE)!.session.current)).toBe(2)
    expect(trackOf(client.getSnapshot().session.current)).toBe(2)
    expect(client.getSnapshot().isActiveDevice).toBe(true)
    expect(trackOf(server.session.current)).toBe(7)
    expect(web.client.getSnapshot()).toMatchObject({ isActiveDevice: true, session: { activeDeviceId: WEB } })
    expect(web.engine.getStatus().state).toBe('playing')
    expect(engine.getStatus().state).toBe('playing')
  })

  it('starts a remote’s own session paused where the shared one was, and plays there when asked', async () => {
    const server = new FakeServer()
    const web = await another(server)
    web.client.dispatch({ type: 'playTracks', tracks: seeds(1, 2, 3), seed: 1 })
    await web.settle()
    const phone = setup({ server })
    await phone.settle()
    await vi.advanceTimersByTimeAsync(15_000)

    await detached(phone, web)
    expect(phone.client.getSnapshot()).toMatchObject({ detached: true, isActiveDevice: false, session: { playing: false, positionMs: 15_000, activeDeviceId: null } })
    expect(trackOf(phone.client.getSnapshot().session.current)).toBe(1)
    expect(phone.client.getSnapshot().queue.queue.map(trackOf)).toEqual([2, 3])
    expect(phone.calls('load')).toEqual([])
    expect(web.client.getSnapshot().session).toMatchObject({ playing: true, activeDeviceId: WEB })

    phone.client.dispatch({ type: 'play' })
    await quiet(phone, web)
    expect(phone.client.getSnapshot().isActiveDevice).toBe(true)
    expect(phone.calls('load')[0]![1]).toMatchObject({ startMs: 15_000, autoplay: true })
    expect(web.client.getSnapshot().session).toMatchObject({ playing: true, activeDeviceId: WEB })
    expect(web.engine.getStatus().state).toBe('playing')
  })

  it('does not try a transfer out of its own session or into another device’s', async () => {
    const phone = await playingHere()
    const web = await another(phone.server)
    await detached(phone, web)
    const sent = phone.server.commands.length
    phone.client.dispatch({ type: 'transfer', deviceId: WEB })
    web.client.dispatch({ type: 'transfer', deviceId: PHONE })
    await quiet(phone, web)
    expect(phone.server.commands).toHaveLength(sent)
    expect(phone.engine.getStatus().state).toBe('playing')
    expect(phone.calls('stop')).toEqual([])
    expect(phone.client.getSnapshot().isActiveDevice).toBe(true)
  })

  it('rejoins the shared session as a remote and stops what it played on its own', async () => {
    const phone = await playingHere()
    const { server, client, engine } = phone
    const web = await another(server)
    await detached(phone, web)
    web.client.dispatch({ type: 'playTracks', tracks: seeds(7, 8), seed: 1 })
    await quiet(phone, web)

    const done = client.attach()
    await quiet(phone, web)
    expect(await done).toEqual({ ok: true })
    expect(server.own.has(PHONE)).toBe(false)
    expect(client.getSnapshot()).toMatchObject({ detached: false, isActiveDevice: false, session: { activeDeviceId: WEB, playing: true } })
    expect(trackOf(client.getSnapshot().session.current)).toBe(7)
    expect(engine.getStatus().state).toBe('idle')
    expect(web.client.getSnapshot().devices.find(device => device.id === PHONE)).toMatchObject({ canPlay: true })
    expect(web.engine.getStatus().state).toBe('playing')

    // An ordinary remote again: its commands reach the shared session.
    client.dispatch({ type: 'pause' })
    await quiet(phone, web)
    expect(server.session.playing).toBe(false)
  })

  it('brings its own session back with it and carries on as the active device', async () => {
    const phone = await playingHere()
    const { server, client, calls } = phone
    const web = await another(server)
    await detached(phone, web)
    web.client.dispatch({ type: 'playTracks', tracks: seeds(7, 8), seed: 1 })
    client.dispatch({ type: 'next' })
    client.dispatch({ type: 'setVolume', deviceId: PHONE, value: 0.4 })
    await quiet(phone, web)
    await vi.advanceTimersByTimeAsync(20_000)
    const entryId = client.getSnapshot().session.current!.id
    const loads = calls('load').length

    const done = client.attach({ bringQueue: true })
    await quiet(phone, web)
    expect(await done).toEqual({ ok: true })
    expect(server.own.has(PHONE)).toBe(false)
    expect(client.getSnapshot()).toMatchObject({ detached: false, isActiveDevice: true, session: { playing: true, activeDeviceId: PHONE, current: { id: entryId } } })
    expect(calls('load')).toHaveLength(loads)
    expect(calls('stop')).toEqual([])
    expect(client.getPositionMs()).toBe(20_000)
    // The other devices now follow what this one brought, and whatever they played stopped.
    expect(web.client.getSnapshot()).toMatchObject({ isActiveDevice: false, session: { activeDeviceId: PHONE, playing: true, current: { id: entryId } } })
    expect(web.client.getSnapshot().queue.queue.map(trackOf)).toEqual([3])
    expect(web.client.getSnapshot().session.volumes).toEqual({ [PHONE]: 0.4 })
    expect(positionAt(server.session, server.now())).toBe(20_000)
    expect(web.engine.getStatus().state).toBe('idle')
  })

  it('stays detached when there is nothing to bring', async () => {
    const phone = setup()
    await phone.settle()
    await detached(phone)
    const done = phone.client.attach({ bringQueue: true })
    await phone.settle()
    expect(await done).toEqual({ ok: false, error: 'nothing_to_bring' })
    expect(phone.client.getSnapshot().detached).toBe(true)
  })

  it('refuses to detach or attach offline, and while one is under way', async () => {
    const phone = await playingHere()
    const { server, client, transport } = phone
    transport.disconnect()
    expect(await client.detach()).toEqual({ ok: false, error: 'offline' })
    transport.connect()
    await phone.settle()
    expect(client.getSnapshot().detached).toBe(false)
    expect(server.own.size).toBe(0)

    const first = client.detach()
    expect(await client.detach()).toEqual({ ok: false, error: 'busy' })
    expect(await client.attach()).toEqual({ ok: false, error: 'busy' })
    await phone.settle()
    expect(await first).toEqual({ ok: true })
  })

  it('reports what the server refused and a request it never answered', async () => {
    const phone = await playingHere()
    phone.server.rejecting = true
    const refused = phone.client.detach()
    await phone.settle()
    expect(await refused).toEqual({ ok: false, error: 'rejected' })

    phone.server.rejecting = false
    phone.server.old = true
    const unanswered = phone.client.detach()
    await phone.settle()
    await vi.advanceTimersByTimeAsync(10_000)
    await phone.settle()
    expect(await unanswered).toEqual({ ok: false, error: 'timeout' })
    expect(phone.client.getSnapshot()).toMatchObject({ detached: false, isActiveDevice: true })
    expect(phone.engine.getStatus().state).toBe('playing')
  })

  it('asks again where it is when a move went unanswered, and takes the answer', async () => {
    const phone = await playingHere()
    phone.server.silentMoves = true
    const hellos = phone.server.hellos.length
    const late = phone.client.detach()
    await phone.settle()
    await vi.advanceTimersByTimeAsync(10_000)
    await phone.settle()
    expect(phone.server.hellos.length).toBe(hellos + 1)
    expect(await late).toEqual({ ok: true })
    expect(phone.client.getSnapshot()).toMatchObject({ detached: true, isActiveDevice: true, connection: 'online' })
    expect(phone.engine.getStatus().state).toBe('playing')
  })

  it('forgets commands made before the request and sends those made after it to the new session', async () => {
    const phone = await playingHere()
    const { server, client } = phone
    client.dispatch({ type: 'setRepeat', value: 'all' })
    const done = client.detach()
    client.dispatch({ type: 'setShuffle', value: true, seed: 3 })
    expect(client.getSnapshot().session).toMatchObject({ repeat: 'all', shuffle: true })
    await phone.settle()
    expect(await done).toEqual({ ok: true })
    // Repeat reached the shared session before it was copied; shuffle only this device's own.
    expect(server.session).toMatchObject({ repeat: 'all', shuffle: false })
    expect(server.own.get(PHONE)!.session).toMatchObject({ repeat: 'all', shuffle: true })
    expect(client.getSnapshot().session).toMatchObject({ repeat: 'all', shuffle: true })
    expect(client.save().pending).toEqual([])
  })

  it('learns from the next hello that a detach whose answer was lost did happen', async () => {
    const phone = await playingHere()
    const { server, client, transport, engine } = phone
    let result: unknown
    void client.detach().then((value) => { result = value })
    transport.flushToServer()
    transport.disconnect()
    client.dispatch({ type: 'setRepeat', value: 'one' })
    await vi.advanceTimersByTimeAsync(0)
    expect(result).toBeUndefined()
    expect(server.own.has(PHONE)).toBe(true)

    transport.connect()
    await phone.settle()
    expect(result).toEqual({ ok: true })
    expect(client.getSnapshot()).toMatchObject({ detached: true, isActiveDevice: true, session: { repeat: 'one' } })
    expect(server.own.get(PHONE)!.session.repeat).toBe('one')
    expect(server.session.repeat).toBe('off')
    expect(engine.getStatus().state).toBe('playing')
    await vi.advanceTimersByTimeAsync(10_000)
    expect(client.getSnapshot().detached).toBe(true)
  })

  it('reports a detach that never reached the server', async () => {
    const phone = await playingHere()
    const done = phone.client.detach()
    phone.transport.disconnect()
    phone.transport.connect()
    await phone.settle()
    expect(await done).toEqual({ ok: false, error: 'disconnected' })
    expect(phone.client.getSnapshot()).toMatchObject({ detached: false, isActiveDevice: true })
    expect(phone.server.own.size).toBe(0)
  })

  it('saves that it was detached, shows it on relaunch and resumes its own session with what it did offline', async () => {
    const first = await playingHere()
    await detached(first)
    first.transport.disconnect()
    first.client.dispatch({ type: 'next' })
    const saved = JSON.parse(JSON.stringify(first.client.save())) as SavedSession
    expect(saved.detached).toBe(true)
    first.client.dispose()

    const { server, client, transport, settle, ended } = setup({ restore: saved, connect: false, server: first.server })
    expect(client.getSnapshot()).toMatchObject({ detached: true, connection: 'offline', session: { playing: false } })
    expect(trackOf(client.getSnapshot().session.current)).toBe(2)
    transport.connect()
    await settle()
    expect(server.hellos.at(-1)).toMatchObject({ detached: true })
    expect(client.getSnapshot()).toMatchObject({ detached: true, connection: 'online' })
    expect(trackOf(server.own.get(PHONE)!.session.current)).toBe(2)
    expect(trackOf(server.session.current)).toBe(1)
    expect(ended).not.toHaveBeenCalled()
  })

  it('lands in the shared session with the reason when its own is gone, and sends nothing made for the other', async () => {
    const first = await playingHere()
    await detached(first)
    first.transport.disconnect()
    first.client.dispatch({ type: 'next' })
    first.client.dispatch({ type: 'setRepeat', value: 'one' })
    const saved = first.client.save()
    first.client.dispose()
    first.server.own.clear()
    first.server.ended = 'expired'
    const shared = first.server.session

    const { server, client, transport, engine, settle, ended } = setup({ restore: saved, connect: false, server: first.server })
    transport.connect()
    await settle()
    expect(ended.mock.calls).toEqual([['expired']])
    expect(client.getSnapshot()).toMatchObject({ detached: false, isActiveDevice: false, canDetach: true })
    expect(server.session).toBe(shared)
    expect(client.save().pending).toEqual([])
    expect(engine.getStatus().state).toBe('idle')
  })

  it('follows the server when it holds an own session this client did not know of', async () => {
    const server = new FakeServer()
    const first = await playingHere(3, server)
    await detached(first)
    first.transport.disconnect()
    first.client.dispose()

    // The same device with nothing saved: a reinstall, or a sign-out and back in.
    const { client, transport, settle, ended } = setup({ server, connect: false })
    client.dispatch({ type: 'setRepeat', value: 'one' })
    transport.connect()
    await settle()
    expect(server.hellos.at(-1)).toMatchObject({ detached: false })
    expect(client.getSnapshot().detached).toBe(true)
    expect(trackOf(client.getSnapshot().session.current)).toBe(1)
    // What it did while it took itself to be in the shared session went nowhere.
    expect(server.own.get(PHONE)!.session.repeat).toBe('off')
    expect(server.session.repeat).toBe('off')
    expect(ended).not.toHaveBeenCalled()
  })

  it('follows its device when another socket of it detaches and attaches', async () => {
    const phone = await playingHere()
    const twin = await another(phone.server, PHONE)
    await detached(phone, twin)
    expect(twin.client.getSnapshot()).toMatchObject({ detached: true, session: { activeDeviceId: PHONE } })
    twin.client.dispatch({ type: 'setRepeat', value: 'all' })
    await quiet(phone, twin)
    expect(phone.client.getSnapshot().session.repeat).toBe('all')
    expect(phone.server.session.repeat).toBe('off')

    const done = twin.client.attach()
    await quiet(phone, twin)
    expect(await done).toEqual({ ok: true })
    expect(phone.client.getSnapshot()).toMatchObject({ detached: false, session: { repeat: 'off' } })
    expect(phone.engine.getStatus().state).toBe('idle')
  })

  it('takes its own session back after playing on through a long disconnect', async () => {
    const phone = await playingHere()
    const { server, client, transport, engine } = phone
    await detached(phone)
    transport.disconnect()
    await vi.advanceTimersByTimeAsync(25_000)
    server.apply({ type: 'deviceLost', deviceId: PHONE }, undefined, undefined, server.own.get(PHONE)!)
    await vi.advanceTimersByTimeAsync(10_000)
    transport.connect()
    await phone.settle()
    const own = server.own.get(PHONE)!.session
    expect(own).toMatchObject({ activeDeviceId: PHONE, playing: true })
    expect(positionAt(own, server.now())).toBe(35_000)
    expect(server.session).toMatchObject({ activeDeviceId: null, playing: false })
    expect(client.getSnapshot()).toMatchObject({ detached: true, isActiveDevice: true })
    expect(engine.getStatus()).toMatchObject({ state: 'playing', positionMs: 35_000 })
  })
})

describe('SessionClient sleep timer', () => {
  async function playingHere(count = 3) {
    const context = setup()
    await context.settle()
    context.client.dispatch({ type: 'playTracks', tracks: seeds(...Array.from({ length: count }, (_, i) => i + 1)), seed: 1 })
    await context.settle()
    return context
  }

  it('offers the timer only when the server says it takes one', async () => {
    const current = setup()
    expect(current.client.getSnapshot().canSetSleepTimer).toBe(false)
    await current.settle()
    expect(current.client.getSnapshot().canSetSleepTimer).toBe(true)
    const server = new FakeServer()
    server.old = true
    const old = setup({ server })
    await old.settle()
    expect(old.client.getSnapshot().canSetSleepTimer).toBe(false)
  })

  it('fades this device out over the last seconds, and comes back to full volume with the server’s pause', async () => {
    const { client, server, transport, engine, settle } = await playingHere()
    client.dispatch({ type: 'setSleepTimer', timer: { kind: 'time', durationMs: 60_000 } })
    await settle()
    await vi.advanceTimersByTimeAsync(45_000)
    expect(engine.loaded!.gain).toBe(1)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(engine.loaded!.gain).toBeCloseTo(0.5, 1)
    await vi.advanceTimersByTimeAsync(5000)
    expect(engine.loaded!.gain).toBe(0)
    // The session's volume is the listener's: only the output fades.
    expect(client.getSnapshot().session.volumes[PHONE]).toBeUndefined()
    server.apply({ type: 'endSleepTimer' })
    transport.flush()
    expect(engine.getStatus().state).toBe('paused')
    expect(engine.loaded!.gain).toBe(1)
    expect(client.getSnapshot().session.sleepTimer).toBeUndefined()
    await settle()
  })

  it('at the end of the song, fades with the engine, preloads nothing and loads the next song paused', async () => {
    const { client, server, transport, engine, calls, settle } = await playingHere()
    client.dispatch({ type: 'setSleepTimer', timer: { kind: 'track' } })
    await settle()
    expect(engine.preloaded).toBeNull()
    await vi.advanceTimersByTimeAsync(195_000)
    expect(engine.loaded!.gain).toBeCloseTo(0.5, 1)
    engine.finish()
    await settle()
    expect(client.getSnapshot().session).toMatchObject({ playing: false, positionMs: 0 })
    expect(trackOf(client.getSnapshot().session.current)).toBe(2)
    expect(calls('load').at(-1)).toMatchObject([ 'load', { autoplay: false, gain: 1 }])
    transport.flush()
    expect(server.session).toMatchObject({ playing: false })
    expect(server.session.sleepTimer).toBeUndefined()
  })

  it('pauses itself past the end while offline, where the server’s pause cannot reach it', async () => {
    const { client, transport, engine, settle } = await playingHere()
    client.dispatch({ type: 'setSleepTimer', timer: { kind: 'time', durationMs: 60_000 } })
    await settle()
    transport.disconnect()
    await vi.advanceTimersByTimeAsync(61_000)
    expect(engine.getStatus().state).toBe('playing')
    expect(engine.loaded!.gain).toBe(0)
    await vi.advanceTimersByTimeAsync(1500)
    expect(client.getSnapshot().session.playing).toBe(false)
    expect(engine.getStatus().state).toBe('paused')
  })
})
