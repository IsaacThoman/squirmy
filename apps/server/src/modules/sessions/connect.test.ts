import type { AddressInfo } from 'node:net'
import { FakeEngine, SessionClient } from '@squirmy/client-core'
import { createSocketTransport, type SquirmySocket } from '@squirmy/client-core/socket'
import type { PlaybackDescriptor, QueueEntry, SessionCommand } from '@squirmy/contracts'
import type { FastifyInstance } from 'fastify'
import { io as connect } from 'socket.io-client'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { buildApp } from '../../app.js'
import { db } from '../../database/client.js'
import { newId } from '../../lib/ids.js'
import { startRealtime } from '../../realtime/index.js'
import { useTestDatabase } from '../../test/database.js'
import { createAlbum, createUser } from '../../test/factories.js'
import { createSession } from '../auth/service.js'
import { sessionsModule } from './index.js'
import { configureSessions, getSnapshot } from './service.js'

/**
 * End to end: real `SessionClient`s from client-core, each with a `FakeEngine`, talking
 * to the real server over socket.io. The server's session clock, the clients' clocks and
 * the engines' clocks are one fake clock that moves only when a test advances it.
 */

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

type Device = { id: string; client: SessionClient; engine: FakeEngine; socket: SquirmySocket }

describe('sessions end to end', () => {
  useTestDatabase()
  let app: FastifyInstance
  let url = ''
  let token = ''
  let userId = ''
  let time = 0
  const now = () => time
  const devices: Device[] = []
  let album: Awaited<ReturnType<typeof createAlbum>>

  beforeAll(async () => {
    app = await buildApp()
    await sessionsModule.realtime!(await startRealtime(app))
    await app.listen({ host: '127.0.0.1', port: 0 })
    url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`
    album = await createAlbum({ owned: true, tracks: [{ title: 'One', durationMs: 200_000 }, { title: 'Two', durationMs: 200_000 }, { title: 'Three', durationMs: 200_000 }] })
  })
  beforeEach(async () => {
    time = 1_800_000_000_000
    configureSessions({ now, deviceGraceMs: 20_000 })
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
      trackId: entry.trackId,
      albumId: entry.albumId,
      fileId: newId(),
      url: `/api/v1/stream/${entry.trackId}`,
      expiresAt: new Date(time + 12 * 3600_000).toISOString(),
      profile: 'original',
      transcoded: false,
      mime: 'audio/flac',
      codec: 'flac',
      lossless: true,
      bitrate: null,
      sampleRate: null,
      bitDepth: null,
      durationMs: 200_000,
      bytes: null,
      normalization: null,
    }
  }

  async function device(id: string): Promise<Device> {
    const socket: SquirmySocket = connect(url, { path: '/socket.io', transports: ['websocket'], reconnection: false, autoConnect: false, auth: { token } })
    const engine = new FakeEngine(now)
    engine.durationMs = 200_000
    const client = new SessionClient({
      transport: createSocketTransport(socket),
      device: { id, name: id, kind: 'web' },
      player: { engine, resolvePlayback: async (entry) => descriptor(entry), baseUrl: url, normalization: 'off' },
      now,
      reportIntervalMs: 3_600_000,
    })
    client.start()
    const created = { id, client, engine, socket }
    devices.push(created)
    await online(created)
    return created
  }

  async function online(target: Device): Promise<void> {
    target.socket.connect()
    await eventually(() => expect(target.client.getSnapshot().connection).toBe('online'))
  }

  async function offline(target: Device): Promise<void> {
    target.socket.disconnect()
    await eventually(() => expect(target.client.getSnapshot().connection).toBe('offline'))
  }

  const playAlbum = (): SessionCommand => ({
    type: 'playTracks',
    tracks: album.tracks.map((track) => ({ trackId: track.recordingId, albumId: album.albumId, durationMs: 0 })),
    seed: 1,
    context: { type: 'album', id: album.albumId, title: album.title },
  })
  const current = (target: Device) => target.client.getSnapshot().session.current
  const engineState = (target: Device) => target.engine.getStatus()

  /** Waits until the server and every client in the shared session agree on its state and queue. */
  async function settled(): Promise<void> {
    await eventually(async () => {
      const { state, queue } = await getSnapshot(userId)
      for (const target of devices) {
        if (target.client.getSnapshot().connection !== 'online' || target.client.getSnapshot().detached) continue
        expect(target.client.getSnapshot().session).toEqual(state)
        expect(target.client.getSnapshot().queue).toEqual(queue)
      }
    })
  }

  it('plays an album on one device while another follows and controls it', async () => {
    const a = await device('device-a-e2e1')
    const b = await device('device-b-e2e1')
    a.client.dispatch(playAlbum())
    await settled()
    const first = current(a)!
    expect(first).toMatchObject({ trackId: album.tracks[0]!.recordingId, durationMs: 200_000 })
    expect(b.client.getSnapshot()).toMatchObject({ isActiveDevice: false, session: { activeDeviceId: 'device-a-e2e1', playing: true } })
    expect(b.client.getSnapshot().devices.find((item) => item.isActive)?.id).toBe('device-a-e2e1')
    await eventually(() => expect(engineState(a)).toEqual({ entryId: first.id, state: 'playing', positionMs: 0 }))
    expect(engineState(b).state).toBe('idle')

    time += 30_000
    expect(a.client.getPositionMs()).toBe(30_000)
    expect(b.client.getPositionMs()).toBe(30_000)

    b.client.dispatch({ type: 'pause' })
    await settled()
    await eventually(() => expect(engineState(a)).toMatchObject({ state: 'paused', positionMs: 30_000 }))

    b.client.dispatch({ type: 'seek', positionMs: 90_000 })
    await settled()
    await eventually(() => expect(engineState(a)).toMatchObject({ state: 'paused', positionMs: 90_000 }))

    b.client.dispatch({ type: 'play' })
    await settled()
    await eventually(() => expect(engineState(a).state).toBe('playing'))
    time += 10_000
    expect(b.client.getPositionMs()).toBe(100_000)

    // A reaches the end on its own and moves to the preloaded entry without a new load.
    await eventually(() => expect(a.engine.preloaded).not.toBeNull())
    const second = a.engine.preloaded!.entryId
    const loads = a.engine.calls.filter(([method]) => method === 'load').length
    a.engine.finish()
    expect(engineState(a)).toMatchObject({ entryId: second, state: 'playing' })
    await settled()
    expect(current(b)!.id).toBe(second)
    expect(b.client.getPositionMs()).toBe(0)
    expect(a.engine.calls.filter(([method]) => method === 'load')).toHaveLength(loads)

    time += 15_000
    b.client.dispatch({ type: 'transfer', deviceId: 'device-b-e2e1' })
    await settled()
    await eventually(() => expect(engineState(a)).toEqual({ entryId: null, state: 'idle', positionMs: 0 }))
    await eventually(() => expect(engineState(b)).toEqual({ entryId: second, state: 'playing', positionMs: 15_000 }))
    expect(b.client.getSnapshot().isActiveDevice).toBe(true)
    expect(a.client.getSnapshot().devices.find((item) => item.isActive)?.id).toBe('device-b-e2e1')
  })

  it('lets a device advance while offline and applies its commands when it returns', async () => {
    const a = await device('device-a-e2e2')
    const b = await device('device-b-e2e2')
    a.client.dispatch(playAlbum())
    await settled()
    const first = current(a)!
    await eventually(() => expect(a.engine.preloaded).not.toBeNull())
    const second = a.engine.preloaded!.entryId

    await offline(a)
    time += 200_000
    a.engine.finish()
    expect(current(a)!.id).toBe(second)
    expect(engineState(a)).toMatchObject({ entryId: second, state: 'playing' })
    time += 5_000
    a.client.dispatch({ type: 'setRepeat', value: 'all' })
    expect(current(b)!.id).toBe(first.id)

    await online(a)
    await settled()
    expect(current(b)!.id).toBe(second)
    expect(b.client.getSnapshot().session).toMatchObject({ activeDeviceId: 'device-a-e2e2', playing: true, repeat: 'all' })
    expect(engineState(a)).toMatchObject({ entryId: second, state: 'playing' })
  })

  it('stops a returning device when another one took over while it was gone', async () => {
    const a = await device('device-a-e2e3')
    const b = await device('device-b-e2e3')
    a.client.dispatch(playAlbum())
    await settled()
    time += 20_000

    await offline(a)
    b.client.dispatch({ type: 'transfer', deviceId: 'device-b-e2e3', play: true })
    await settled()
    await eventually(() => expect(engineState(b)).toMatchObject({ state: 'playing', positionMs: 20_000 }))
    time += 5_000
    a.client.dispatch({ type: 'next' })
    a.client.dispatch({ type: 'setShuffle', value: false, seed: 1 })
    a.client.dispatch({ type: 'setRepeat', value: 'one' })
    expect(engineState(a).state).toBe('playing')

    await online(a)
    await settled()
    expect(engineState(a).state).toBe('idle')
    expect(a.client.getSnapshot().isActiveDevice).toBe(false)
    // The playback command was dropped; the setting went through.
    expect(b.client.getSnapshot().session).toMatchObject({ activeDeviceId: 'device-b-e2e3', playing: true, repeat: 'one', positionMs: 20_000 })
    expect(b.client.getPositionMs()).toBe(25_000)
    expect(engineState(b)).toMatchObject({ state: 'playing', positionMs: 25_000 })
  })

  it('pauses after the grace period, and the device reclaims the session when it returns still playing', async () => {
    configureSessions({ deviceGraceMs: 100 })
    const a = await device('device-a-e2e4')
    const b = await device('device-b-e2e4')
    a.client.dispatch(playAlbum())
    await settled()
    time += 30_000

    await offline(a)
    await eventually(() => expect(b.client.getSnapshot().session).toMatchObject({ activeDeviceId: null, playing: false, positionMs: 30_000 }))
    time += 12_000
    expect(engineState(a)).toMatchObject({ state: 'playing', positionMs: 42_000 })

    await online(a)
    await settled()
    expect(b.client.getSnapshot().session).toMatchObject({ activeDeviceId: 'device-a-e2e4', playing: true, positionMs: 42_000 })
    expect(engineState(a)).toMatchObject({ state: 'playing', positionMs: 42_000 })
  })

  it('detaches a playing device without a gap, plays on its own, and brings its queue back', async () => {
    const elsewhere = await createAlbum({ owned: true, tracks: [{ title: 'Elsewhere', durationMs: 200_000 }] })
    const a = await device('device-a-e2e5')
    const b = await device('device-b-e2e5')
    expect(a.client.getSnapshot()).toMatchObject({ detached: false, canDetach: true })
    a.client.dispatch(playAlbum())
    await settled()
    const first = current(a)!
    await eventually(() => expect(engineState(a)).toMatchObject({ entryId: first.id, state: 'playing' }))
    const loads = () => a.engine.calls.filter(([method]) => method === 'load').length
    const loaded = loads()
    time += 30_000

    expect(await a.client.detach()).toEqual({ ok: true })
    expect(a.client.getSnapshot()).toMatchObject({ detached: true, isActiveDevice: true, session: { current: { id: first.id }, playing: true } })
    expect(engineState(a)).toMatchObject({ entryId: first.id, state: 'playing', positionMs: 30_000 })
    expect(loads()).toBe(loaded)
    await settled()
    expect(b.client.getSnapshot().session).toMatchObject({ activeDeviceId: null, playing: false, positionMs: 30_000 })
    await eventually(() => expect(b.client.getSnapshot().devices.find((item) => item.id === 'device-a-e2e5')).toMatchObject({ canPlay: false, detached: { playing: true } }))

    // The two sessions go their own ways.
    b.client.dispatch({
      type: 'playTracks',
      tracks: elsewhere.tracks.map((track) => ({ trackId: track.recordingId, albumId: elsewhere.albumId, durationMs: 0 })),
      seed: 2,
    })
    await settled()
    await eventually(() => expect(engineState(b)).toMatchObject({ state: 'playing' }))
    a.client.dispatch({ type: 'next' })
    await eventually(() => expect(current(a)!.trackId).toBe(album.tracks[1]!.recordingId))
    expect(current(b)!.trackId).toBe(elsewhere.tracks[0]!.recordingId)
    expect(engineState(a)).toMatchObject({ state: 'playing' })
    expect(engineState(b)).toMatchObject({ state: 'playing' })

    // The server remembers: a reconnect lands back in the device's own session.
    await offline(a)
    await online(a)
    expect(a.client.getSnapshot()).toMatchObject({ detached: true, session: { current: { trackId: album.tracks[1]!.recordingId } } })
    expect(engineState(a)).toMatchObject({ state: 'playing' })

    time += 10_000
    expect(await a.client.attach({ bringQueue: true })).toEqual({ ok: true })
    expect(a.client.getSnapshot()).toMatchObject({ detached: false, isActiveDevice: true })
    await settled()
    expect(current(b)!.trackId).toBe(album.tracks[1]!.recordingId)
    expect(b.client.getSnapshot().session).toMatchObject({ activeDeviceId: 'device-a-e2e5', playing: true })
    await eventually(() => expect(engineState(b).state).toBe('idle'))
    expect(engineState(a)).toMatchObject({ state: 'playing' })
  })
})
