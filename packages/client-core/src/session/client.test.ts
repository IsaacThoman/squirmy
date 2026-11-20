import type {
  AnySessionCommand,
} from './reducer.js'
import type {
  CommandEnvelope,
  DeviceInfo,
  EngineReport,
  PlaybackDescriptor,
  QueueEntry,
  QueueSeed,
  ServerToClientEvents,
} from '@squirmy/contracts'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FakeEngine } from '../engine.js'
import { type SavedSession, SessionClient } from './client.js'
import { createInitialSession, positionAt, queueChanged, reduceSession, splitSession } from './reducer.js'
import type { AckCallback, AckEvent, AckPayload, AckReply, SessionTransport } from './transport.js'

const PHONE = 'phone-0001'
const WEB = 'web-00001'
const SERVER_OFFSET = 5000
const track = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const seeds = (...ns: number[]): QueueSeed[] => ns.map(n => ({ trackId: track(n), albumId: null, durationMs: 200_000 }))
const trackOf = (entry: QueueEntry | null | undefined) => entry && Number(entry.trackId.slice(-12))

/** The server side: the real reducer, versions, command de-duplication, ordered replies. */
class FakeServer {
  session = createInitialSession()
  version = 1
  queueVersion = 1
  readonly transports = new Set<FakeTransport>()
  readonly commands: CommandEnvelope[] = []
  readonly reports: EngineReport[] = []
  readonly seen = new Set<string>()
  rejecting = false
  private serial = 0

  now(): number {
    return Date.now() + SERVER_OFFSET
  }

  /** Applies a command as if another device (or the server itself) sent it. */
  apply(command: AnySessionCommand, deviceId?: string, commandId = `server-${(this.serial += 1)}`): void {
    const previous = this.session
    const next = reduceSession(previous, { command, now: this.now(), commandId, deviceId })
    if (next === previous) return
    this.session = next
    this.version += 1
    const queue = queueChanged(previous, next)
    if (queue) this.queueVersion += 1
    const halves = splitSession(next)
    for (const transport of this.transports) {
      if (queue) transport.push('session:queue', { version: this.version, queueVersion: this.queueVersion, queue: halves.queue })
      transport.push('session:state', { version: this.version, state: halves.state })
    }
  }

  devices(): DeviceInfo[] {
    return [...this.transports].filter(transport => transport.deviceId).map(transport => ({
      id: transport.deviceId!, name: transport.deviceId!, kind: 'other', canPlay: true, isActive: this.session.activeDeviceId === transport.deviceId,
    }))
  }

  receive<E extends AckEvent>(transport: FakeTransport, event: E, payload: AckPayload<E>, reply: (value: AckReply<E>) => void): void {
    const send = reply as (value: unknown) => void
    if (event === 'session:hello') {
      const hello = payload as AckPayload<'session:hello'>
      transport.deviceId = hello.device.id
      const { state, queue } = splitSession(this.session)
      send({ serverTime: this.now(), snapshot: { version: this.version, queueVersion: this.queueVersion, state, queue }, devices: this.devices() })
    } else if (event === 'time:sync') {
      send({ clientTime: payload, serverTime: this.now() })
    } else {
      const envelope = payload as CommandEnvelope
      this.commands.push(envelope)
      if (this.rejecting) return send({ ok: false, error: 'rejected' })
      if (this.seen.has(envelope.commandId)) return send({ ok: true, version: this.version })
      // As the real server: only the active device may end a track.
      if (envelope.command.type === 'trackEnded' && this.session.activeDeviceId !== transport.deviceId) {
        return send({ ok: false, error: 'not_active_device' })
      }
      this.seen.add(envelope.commandId)
      const before = this.session
      const next = reduceSession(before, { command: envelope.command, now: this.now(), commandId: envelope.commandId, deviceId: transport.deviceId })
      // The protocol acks before it broadcasts.
      send({ ok: true, version: next === before ? this.version : this.version + 1 })
      if (next !== before) {
        this.session = before
        this.apply(envelope.command, transport.deviceId, envelope.commandId)
      }
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

function setup({ canPlay = true, connect = true, restore, server = new FakeServer() }: {
  canPlay?: boolean; connect?: boolean; restore?: SavedSession; server?: FakeServer
} = {}) {
  const transport = new FakeTransport(server)
  const engine = new FakeEngine()
  engine.durationMs = 200_000
  const resolvePlayback = vi.fn(async (entry: QueueEntry) => descriptor(entry))
  const client = new SessionClient({
    transport,
    device: { id: PHONE, name: 'Phone', kind: 'ios' },
    player: canPlay ? { engine, resolvePlayback, baseUrl: 'https://music.test', normalization: 'off' } : undefined,
    restore,
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
  return { server, transport, engine, client, resolvePlayback, settle, calls }
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

    server.apply({ type: 'deviceLost', deviceId: PHONE })
    transport.connect()
    await settle()
    expect(trackOf(server.session.current)).toBe(2)
    expect(server.session).toMatchObject({ playing: false, positionMs: 20_000 })
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
