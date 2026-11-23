import type { AddressInfo } from 'node:net'
import { FakeEngine, idleHint, SessionClient } from '@squirmy/client-core'
import { createSocketTransport, type SquirmySocket } from '@squirmy/client-core/socket'
import type { DeviceInfo, PlaybackDescriptor, QueueEntry } from '@squirmy/contracts'
import type { FastifyInstance } from 'fastify'
import { io as connect } from 'socket.io-client'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { buildApp } from '../../app.js'
import { db } from '../../database/client.js'
import { newId } from '../../lib/ids.js'
import { type Realtime, startRealtime } from '../../realtime/index.js'
import { useTestDatabase } from '../../test/database.js'
import { createAlbum, createUser } from '../../test/factories.js'
import { createSession } from '../auth/service.js'
import { sessionsModule } from './index.js'
import { configureSessions, getDevices, getSnapshot } from './service.js'

/**
 * Presence end to end: real `SessionClient`s over socket.io, with the heartbeat shortened
 * so a device that stops answering is dropped in a fraction of a second rather than in the
 * real 10 to 15 seconds. Timings are real (socket.io's heartbeat runs on real timers); the
 * session clock is a fake one, so positions only move when a test moves them.
 */

const HEARTBEAT = { intervalMs: 50, timeoutMs: 100 }

async function eventually(check: () => void | Promise<void>, timeoutMs = 5000): Promise<void> {
  const deadline = performance.now() + timeoutMs
  for (;;) {
    try {
      await check()
      return
    } catch (error) {
      if (performance.now() > deadline) throw error
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

type Device = { id: string; client: SessionClient; engine: FakeEngine; socket: SquirmySocket; lists: DeviceInfo[][] }

/**
 * Makes the socket stop answering pings while it goes on receiving, as a frozen page or a
 * suspended app does: only the server's heartbeat can tell. Undone by the next reconnect,
 * which opens a fresh engine.
 */
function stopAnswering(socket: SquirmySocket): void {
  const engine = socket.io.engine as unknown as { _sendPacket: (type: string, ...rest: unknown[]) => void }
  const send = engine._sendPacket.bind(engine)
  engine._sendPacket = (type, ...rest) => {
    if (type !== 'pong') send(type, ...rest)
  }
}

describe('device presence', () => {
  useTestDatabase()
  let app: FastifyInstance
  let realtime: Realtime
  let url = ''
  let token = ''
  let userId = ''
  let time = 0
  const now = () => time
  const devices: Device[] = []
  let album: Awaited<ReturnType<typeof createAlbum>>

  beforeAll(async () => {
    app = await buildApp()
    realtime = await startRealtime(app, HEARTBEAT)
    await sessionsModule.realtime!(realtime)
    await app.listen({ host: '127.0.0.1', port: 0 })
    url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`
    album = await createAlbum({ owned: true, tracks: [{ title: 'One', durationMs: 200_000 }, { title: 'Two', durationMs: 200_000 }] })
  })
  beforeEach(async () => {
    time = 1_800_000_000_000
    configureSessions({ now, deviceGraceMs: 60_000 })
    const user = await createUser()
    userId = user.id
    token = (await createSession(db, { userId, clientKind: 'test' })).token
  })
  afterEach(async () => {
    for (const device of devices.splice(0)) {
      device.client.dispose()
      device.socket.disconnect()
    }
    await sessionsModule.stop!()
  })
  afterAll(async () => {
    await app.close()
  })

  function descriptor(entry: QueueEntry): PlaybackDescriptor {
    return {
      trackId: entry.trackId, albumId: entry.albumId, fileId: newId(), url: `/api/v1/stream/${entry.trackId}`,
      expiresAt: new Date(time + 12 * 3600_000).toISOString(), profile: 'original', transcoded: false, mime: 'audio/flac',
      codec: 'flac', lossless: true, bitrate: null, sampleRate: null, bitDepth: null, durationMs: 200_000, bytes: null, normalization: null,
    }
  }

  /** A device that reconnects by itself, quickly, as socket.io clients do after a drop. */
  async function device(id: string, { canPlay = true } = {}): Promise<Device> {
    const socket: SquirmySocket = connect(url, {
      path: '/socket.io', transports: ['websocket'], autoConnect: false, auth: { token },
      reconnectionDelay: 20, reconnectionDelayMax: 50, randomizationFactor: 0,
    })
    const engine = new FakeEngine(now)
    engine.durationMs = 200_000
    const client = new SessionClient({
      transport: createSocketTransport(socket),
      device: { id, name: id, kind: 'web' },
      player: canPlay ? { engine, resolvePlayback: async (entry) => descriptor(entry), baseUrl: url, normalization: 'off' } : undefined,
      now,
      reportIntervalMs: 3_600_000,
    })
    const lists: DeviceInfo[][] = []
    socket.on('devices', (list) => void lists.push(list))
    client.start()
    const created = { id, client, engine, socket, lists }
    devices.push(created)
    socket.connect()
    await eventually(() => expect(client.getSnapshot().connection).toBe('online'))
    return created
  }

  const listed = (target: Device) => target.client.getSnapshot().devices.map((item) => item.id).sort()
  const ids = (...targets: Device[]) => targets.map((target) => target.id).sort()

  it('drops a device that stops answering the heartbeat, within two missed pings', async () => {
    const a = await device('device-a-pres1')
    const b = await device('device-b-pres1')
    await eventually(() => expect(listed(a)).toEqual(ids(a, b)))

    // B's socket stays open and keeps receiving; it only stops answering.
    b.socket.io.reconnection(false)
    stopAnswering(b.socket)
    const stopped = performance.now()
    await eventually(() => expect(listed(a)).toEqual([a.id]))
    const elapsed = performance.now() - stopped
    expect(elapsed).toBeLessThan(HEARTBEAT.intervalMs + HEARTBEAT.timeoutMs + 250)
    expect((await getDevices(userId)).map((item) => item.id)).toEqual([a.id])
  })

  it('keeps a device that answers, however long it stays quiet otherwise', async () => {
    const a = await device('device-a-pres2')
    const b = await device('device-b-pres2', { canPlay: false })
    await eventually(() => expect(listed(a)).toEqual(ids(a, b)))
    const lists = a.lists.length
    // Many heartbeats, and neither device sends anything of its own.
    await pause(10 * (HEARTBEAT.intervalMs + HEARTBEAT.timeoutMs))
    expect(listed(a)).toEqual(ids(a, b))
    expect(a.lists).toHaveLength(lists)
  })

  it('never offers a live device as idle: a tab left untouched is still seen through its heartbeat', async () => {
    const a = await device('device-a-pres7')
    const b = await device('device-b-pres7')
    await eventually(() => expect(listed(a)).toEqual(ids(a, b)))
    // Ten minutes in which B sends nothing of its own: no command, no report.
    time += 10 * 60_000
    await eventually(() => {
      const tab = a.client.getSnapshot().devices.find((item) => item.id === b.id)!
      expect(tab.lastSeenAt).toBe(time)
      expect(idleHint(tab.lastSeenAt, time)).toBe('')
    })
    // Over HTTP too.
    const listedB = (await getDevices(userId)).find((item) => item.id === b.id)!
    expect(idleHint(listedB.lastSeenAt, time)).toBe('')
  })

  it('waits for an active device that went silent without offering it, then lets go after the grace period', async () => {
    configureSessions({ deviceGraceMs: 400 })
    const a = await device('device-a-pres3')
    const b = await device('device-b-pres3')
    a.client.dispatch({ type: 'playTracks', tracks: album.tracks.map((track) => ({ trackId: track.recordingId, albumId: album.albumId, durationMs: 0 })), seed: 1 })
    await eventually(() => expect(b.client.getSnapshot().session).toMatchObject({ activeDeviceId: a.id, playing: true }))
    await eventually(() => expect(listed(b)).toEqual(ids(a, b)))
    time += 30_000

    a.socket.io.reconnection(false)
    stopAnswering(a.socket)
    // Gone from the list, named as away, the clock stopped where it was.
    await eventually(() => expect(listed(b)).toEqual([b.id]))
    expect(b.client.getSnapshot()).toMatchObject({
      away: { id: a.id, device: { id: a.id, name: a.id } },
      session: { activeDeviceId: a.id, playing: true, stalled: true, positionMs: 30_000 },
    })
    // After the grace period, nothing waits for it.
    await eventually(() => expect(b.client.getSnapshot()).toMatchObject({ away: null, session: { activeDeviceId: null, playing: false, positionMs: 30_000 } }))
  })

  it('lists an active device again when it comes back within the grace period, and its music goes on', async () => {
    const a = await device('device-a-pres4')
    const b = await device('device-b-pres4')
    a.client.dispatch({ type: 'playTracks', tracks: album.tracks.map((track) => ({ trackId: track.recordingId, albumId: album.albumId, durationMs: 0 })), seed: 1 })
    await eventually(() => expect(b.client.getSnapshot().session).toMatchObject({ activeDeviceId: a.id, playing: true }))
    time += 30_000

    stopAnswering(a.socket)
    await eventually(() => expect(b.client.getSnapshot().away?.id).toBe(a.id))
    // The client finds out too and reconnects on a fresh engine, which answers again.
    await eventually(() => expect(listed(b)).toEqual(ids(a, b)))
    await eventually(() => expect(b.client.getSnapshot()).toMatchObject({ away: null, session: { activeDeviceId: a.id, playing: true, stalled: false } }))
  })

  it('rebuilds the list after every connection drops at once, and it holds still afterwards', async () => {
    const a = await device('device-a-pres5')
    const b = await device('device-b-pres5')
    const c = await device('device-c-pres5', { canPlay: false })
    a.client.dispatch({ type: 'playTracks', tracks: album.tracks.map((track) => ({ trackId: track.recordingId, albumId: album.albumId, durationMs: 0 })), seed: 1 })
    await eventually(() => expect(c.client.getSnapshot().session).toMatchObject({ activeDeviceId: a.id, playing: true }))
    await eventually(() => expect(listed(c)).toEqual(ids(a, b, c)))

    // As after a server restart or a network blip: every transport closes and every client reconnects.
    const dropped = Promise.all([a, b, c].map((target) => new Promise((resolve) => target.socket.once('disconnect', resolve))))
    for (const socket of realtime.io.of('/').sockets.values()) socket.conn.close()
    await dropped
    await eventually(() => {
      for (const target of [a, b, c]) {
        expect(target.client.getSnapshot().connection).toBe('online')
        expect(listed(target)).toEqual(ids(a, b, c))
      }
    })
    expect((await getDevices(userId)).map((item) => item.id).sort()).toEqual(ids(a, b, c))
    await eventually(async () => expect((await getSnapshot(userId)).state).toMatchObject({ activeDeviceId: a.id, playing: true, stalled: false }))

    // Settled: more heartbeats pass and no list goes out that drops anyone.
    const seen = c.lists.length
    await pause(5 * (HEARTBEAT.intervalMs + HEARTBEAT.timeoutMs))
    for (const list of c.lists.slice(seen)) expect(list.map((item) => item.id).sort()).toEqual(ids(a, b, c))
  })

  it('lists a device once however many of its sockets come and go, until the last one closes', async () => {
    const a = await device('device-a-pres6')
    const tabs: SquirmySocket[] = []
    for (let index = 0; index < 6; index += 1) {
      const socket: SquirmySocket = connect(url, { path: '/socket.io', transports: ['websocket'], reconnection: false, auth: { token }, forceNew: true })
      socket.on('connect', () => socket.emit('session:hello', { device: { id: 'device-b-pres6', name: 'B', kind: 'web' }, canPlay: true, detached: false }, () => undefined))
      tabs.push(socket)
    }
    await eventually(() => expect(listed(a)).toEqual(['device-a-pres6', 'device-b-pres6']))
    for (const socket of tabs.slice(1)) socket.disconnect()
    await pause(3 * (HEARTBEAT.intervalMs + HEARTBEAT.timeoutMs))
    expect(listed(a)).toEqual(['device-a-pres6', 'device-b-pres6'])
    expect(a.client.getSnapshot().devices.filter((item) => item.id === 'device-b-pres6')).toHaveLength(1)
    tabs[0]!.disconnect()
    await eventually(() => expect(listed(a)).toEqual(['device-a-pres6']))
  })
})
