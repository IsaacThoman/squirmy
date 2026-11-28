import type { AddressInfo } from 'node:net'
import { FakeEngine, SessionClient } from '@squirmy/client-core'
import { createSocketTransport, type SquirmySocket } from '@squirmy/client-core/socket'
import type { CommandAck, JamAck, JamRequest, PlaybackDescriptor, QueueEntry, ServerEvent, SessionCommand, SessionQueueOps } from '@squirmy/contracts'
import { eq, inArray } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { io as connect } from 'socket.io-client'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { buildApp } from '../../app.js'
import { db } from '../../database/client.js'
import { plays, users } from '../../database/schema.js'
import { newId } from '../../lib/ids.js'
import { startRealtime } from '../../realtime/index.js'
import { useTestDatabase } from '../../test/database.js'
import { createAlbum, createUser } from '../../test/factories.js'
import { createSession } from '../auth/service.js'
import { sessionsModule } from './index.js'
import { configureSessions, controlPlayback, getSnapshot } from './service.js'

/**
 * Listen together, end to end: real `SessionClient`s with `FakeEngine`s for several users,
 * talking to the real server. One fake clock drives the server, the clients and the engines.
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

type Listener = { userId: string; token: string; name: string }
type Device = { id: string; client: SessionClient; engine: FakeEngine; socket: SquirmySocket; events: ServerEvent[] }

describe('listen together', () => {
  useTestDatabase()
  let app: FastifyInstance
  let url = ''
  let time = 0
  const now = () => time
  const devices: Device[] = []
  let album: Awaited<ReturnType<typeof createAlbum>>
  let host: Listener
  let guest: Listener

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
    host = await listener()
    guest = await listener()
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

  async function listener(): Promise<Listener> {
    const user = await createUser()
    return { userId: user.id, token: (await createSession(db, { userId: user.id, clientKind: 'test' })).token, name: user.username }
  }

  function descriptor(entry: QueueEntry): PlaybackDescriptor {
    return {
      trackId: entry.trackId, albumId: entry.albumId, fileId: newId(), url: `/api/v1/stream/${entry.trackId}`,
      expiresAt: new Date(time + 12 * 3600_000).toISOString(), profile: 'original', transcoded: false, mime: 'audio/flac', codec: 'flac',
      lossless: true, bitrate: null, sampleRate: null, bitDepth: null, durationMs: 200_000, bytes: null, normalization: null,
    }
  }

  async function device(owner: Listener, id: string, options: { jamAlignIntervalMs?: number } = {}): Promise<Device> {
    const socket: SquirmySocket = connect(url, { path: '/socket.io', transports: ['websocket'], reconnection: false, autoConnect: false, auth: { token: owner.token } })
    const engine = new FakeEngine(now)
    engine.durationMs = 200_000
    const events: ServerEvent[] = []
    const client = new SessionClient({
      transport: createSocketTransport(socket),
      device: { id, name: id, kind: 'web' },
      player: { engine, resolvePlayback: async (entry) => descriptor(entry), baseUrl: url, normalization: 'off' },
      onJamEvent: (event) => events.push(event),
      now,
      reportIntervalMs: 3_600_000,
      jamAlignIntervalMs: options.jamAlignIntervalMs ?? 3_600_000,
    })
    client.start()
    const created = { id, client, engine, socket, events }
    devices.push(created)
    socket.connect()
    await eventually(() => expect(client.getSnapshot().connection).toBe('online'))
    return created
  }

  /** Sends a command over the device's socket as an older client would, without the client's own checks. */
  function rawCommand(target: Device, command: SessionCommand): Promise<CommandAck> {
    return new Promise((resolve) => target.socket.emit('session:command', { commandId: newId(), command }, resolve))
  }

  async function jam(target: Device, request: JamRequest): Promise<JamAck> {
    return target.client.jam(request)
  }

  async function started(target: Device): Promise<string> {
    const reply = await jam(target, { action: 'start' })
    if (!reply.ok || !reply.jam) throw new Error(`start failed: ${JSON.stringify(reply)}`)
    return reply.jam.id
  }

  const playAlbum = (): SessionCommand => ({
    type: 'playTracks',
    tracks: album.tracks.map((track) => ({ trackId: track.recordingId, albumId: album.albumId, durationMs: 0 })),
    seed: 1,
    context: { type: 'album', id: album.albumId, title: album.title },
  })

  /** Waits until the member's session holds what the host's does, apart from what is each listener's own. */
  async function inStep(member: Listener): Promise<void> {
    await eventually(async () => {
      const [hostSnapshot, memberSnapshot] = await Promise.all([getSnapshot(host.userId), getSnapshot(member.userId)])
      const { activeDeviceId: _hostDevice, volumes: _hostVolumes, jam: hostJam, sleepTimer: _sleep, ...hostState } = hostSnapshot.state
      const { activeDeviceId: _memberDevice, volumes: _memberVolumes, jam: memberJam, ...memberState } = memberSnapshot.state
      expect(memberState).toEqual(hostState)
      expect(memberSnapshot.queue).toEqual(hostSnapshot.queue)
      expect(memberJam).toEqual({ ...hostJam, role: 'member' })
    })
  }

  it('plays the host\'s session on every member\'s own device, in step', async () => {
    const a = await device(host, 'host-phone-1')
    const b = await device(guest, 'guest-phone-1')
    a.client.dispatch(playAlbum())
    await eventually(async () => expect((await getSnapshot(host.userId)).state.playing).toBe(true))
    time += 30_000
    const jamId = await started(a)
    expect(jamId.length).toBeGreaterThanOrEqual(16)

    const joined = await jam(b, { action: 'join', jamId })
    expect(joined).toMatchObject({ ok: true, jam: { id: jamId, role: 'member', hostUserId: host.userId } })
    await inStep(guest)
    // Each plays on their own device, from the same clock.
    await eventually(() => expect(b.engine.getStatus()).toMatchObject({ entryId: a.client.getSnapshot().session.current!.id, state: 'playing' }))
    expect(b.engine.getStatus().positionMs).toBe(30_000)
    expect(b.client.getSnapshot().session.activeDeviceId).toBe('guest-phone-1')
    expect(a.client.getSnapshot().session.activeDeviceId).toBe('host-phone-1')
    await eventually(() => expect(a.client.getSnapshot().session.jam?.members.map((member) => member.userId)).toEqual([host.userId, guest.userId]))

    a.client.dispatch({ type: 'pause' })
    await inStep(guest)
    await eventually(() => expect(b.engine.getStatus()).toMatchObject({ state: 'paused', positionMs: 30_000 }))
    a.client.dispatch({ type: 'seek', positionMs: 120_000 })
    a.client.dispatch({ type: 'play' })
    await inStep(guest)
    await eventually(() => expect(b.engine.getStatus()).toMatchObject({ state: 'playing', positionMs: 120_000 }))
    a.client.dispatch({ type: 'next' })
    await inStep(guest)
    await eventually(() => expect(b.engine.getStatus().entryId).toBe(a.client.getSnapshot().session.current!.id))
  })

  it('leaves playback to the host and the queue to everyone, as the host chooses', async () => {
    const a = await device(host, 'host-phone-2')
    const b = await device(guest, 'guest-phone-2')
    a.client.dispatch(playAlbum())
    const jamId = await started(a)
    await jam(b, { action: 'join', jamId })
    await inStep(guest)

    for (const command of [{ type: 'pause' }, { type: 'next' }, { type: 'seek', positionMs: 5000 }, playAlbum()] as SessionCommand[]) {
      expect(await rawCommand(b, command)).toEqual({ ok: false, error: 'jam_host_only' })
    }
    expect(await rawCommand(b, { type: 'setSleepTimer', timer: { kind: 'track' } })).toEqual({ ok: false, error: 'jam_unsupported' })
    // Remote controls (the HTTP route, Home Assistant over MQTT) go the same way.
    await expect(controlPlayback(guest.userId, { type: 'pause' }, 'guest-phone-2')).rejects.toMatchObject({ code: 'jam_host_only' })
    // The client does not even try what the server would refuse.
    b.client.dispatch({ type: 'pause' })
    expect(b.client.getSnapshot().session.playing).toBe(true)

    // Members add to the queue, under their name, and can take back only what they added.
    const track = album.tracks[2]!
    b.client.dispatch({ type: 'enqueue', placement: 'next', tracks: [{ trackId: track.recordingId, albumId: album.albumId, durationMs: 0 }] })
    await eventually(async () => expect((await getSnapshot(host.userId)).queue.queue[0]).toMatchObject({ trackId: track.recordingId, addedBy: guest.userId, queued: true }))
    await inStep(guest)
    const hostQueue = (await getSnapshot(host.userId)).queue.queue
    const guestEntry = hostQueue[0]!
    const hostEntry = hostQueue[1]!
    expect(await rawCommand(b, { type: 'removeFromQueue', entryId: hostEntry.id })).toEqual({ ok: false, error: 'jam_host_only' })
    expect(await rawCommand(b, { type: 'removeFromQueue', entryId: guestEntry.id })).toMatchObject({ ok: true })
    await eventually(async () => expect((await getSnapshot(host.userId)).queue.queue.map((entry) => entry.id)).not.toContain(guestEntry.id))

    // The host's own additions are marked as theirs.
    a.client.dispatch({ type: 'enqueue', placement: 'last', tracks: [{ trackId: track.recordingId, albumId: album.albumId, durationMs: 0 }] })
    await eventually(async () => expect((await getSnapshot(host.userId)).queue.queue.at(-1)).toMatchObject({ addedBy: host.userId }))

    expect(await jam(b, { action: 'settings', queuePolicy: 'host' })).toEqual({ ok: false, error: 'jam_host_only' })
    expect(await jam(a, { action: 'settings', queuePolicy: 'host' })).toMatchObject({ ok: true, jam: { queuePolicy: 'host' } })
    await eventually(() => expect(b.client.getSnapshot().session.jam?.queuePolicy).toBe('host'))
    expect(await rawCommand(b, { type: 'enqueue', placement: 'last', tracks: [{ trackId: track.recordingId, durationMs: 0 }] })).toEqual({ ok: false, error: 'jam_host_only' })

    // Volume and which of their own devices plays stay each listener's.
    b.client.dispatch({ type: 'setVolume', deviceId: 'guest-phone-2', value: 0.25 })
    await eventually(async () => expect((await getSnapshot(guest.userId)).state.volumes['guest-phone-2']).toBe(0.25))
    expect((await getSnapshot(host.userId)).state.volumes['guest-phone-2']).toBeUndefined()
    await inStep(guest)
  })

  it('moves everyone on when the first listener reaches the end, and counts a play for each', async () => {
    const a = await device(host, 'host-phone-3')
    const b = await device(guest, 'guest-phone-3')
    a.client.dispatch(playAlbum())
    const jamId = await started(a)
    await jam(b, { action: 'join', jamId })
    await inStep(guest)
    const first = a.client.getSnapshot().session.current!

    // Far from the end, a device that says it finished moves no one.
    time += 10_000
    await eventually(() => expect(b.engine.preloaded).not.toBeNull())
    expect(await rawCommand(b, { type: 'trackEnded', entryId: first.id })).toMatchObject({ ok: true })
    expect((await getSnapshot(host.userId)).state.current!.id).toBe(first.id)

    time += 189_000
    b.engine.finish()
    await eventually(async () => expect((await getSnapshot(host.userId)).state.current!.id).not.toBe(first.id))
    await inStep(guest)
    const second = (await getSnapshot(host.userId)).state.current!
    await eventually(() => expect(a.engine.getStatus().entryId).toBe(second.id))
    expect(b.engine.getStatus().entryId).toBe(second.id)

    await eventually(async () => {
      const rows = await db.select({ userId: plays.userId, recordingId: plays.recordingId, completed: plays.completed }).from(plays).where(eq(plays.recordingId, first.trackId))
      expect(rows).toEqual(expect.arrayContaining([
        { userId: host.userId, recordingId: first.trackId, completed: true },
        { userId: guest.userId, recordingId: first.trackId, completed: true },
      ]))
    })
  })

  it('brings a member\'s device back to the jam\'s clock when it drifts', async () => {
    const a = await device(host, 'host-phone-4')
    const b = await device(guest, 'guest-phone-4', { jamAlignIntervalMs: 20 })
    a.client.dispatch(playAlbum())
    const jamId = await started(a)
    await jam(b, { action: 'join', jamId })
    await inStep(guest)
    await eventually(() => expect(b.engine.getStatus().state).toBe('playing'))
    time += 20_000
    b.engine.buffer()
    time += 2_000
    b.engine.resume()
    // The member's stall does not stop the jam's clock.
    expect((await getSnapshot(host.userId)).state.stalled).toBe(false)
    await eventually(() => expect(b.engine.getStatus().positionMs).toBe(22_000))
    expect(b.engine.calls).toContainEqual(['seek', 22_000])
  })

  it('lets members leave, and pauses them when the host ends the jam', async () => {
    const third = await listener()
    const a = await device(host, 'host-phone-5')
    const b = await device(guest, 'guest-phone-5')
    const c = await device(third, 'third-phone-5')
    a.client.dispatch(playAlbum())
    const jamId = await started(a)
    await jam(b, { action: 'join', jamId })
    await jam(c, { action: 'join', jamId })
    await inStep(guest)
    await inStep(third)

    time += 5000
    expect(await jam(b, { action: 'leave' })).toEqual({ ok: true, jam: null })
    await eventually(async () => {
      const left = (await getSnapshot(guest.userId)).state
      expect(left.jam).toBeUndefined()
      expect(left).toMatchObject({ playing: false, positionMs: 5000 })
    })
    await eventually(() => expect(a.client.getSnapshot().session.jam?.members.map((member) => member.userId)).toEqual([host.userId, third.userId]))
    await eventually(() => expect(b.engine.getStatus().state).toBe('paused'))

    expect(await jam(c, { action: 'end' })).toEqual({ ok: false, error: 'jam_host_only' })
    expect(await jam(a, { action: 'end' })).toEqual({ ok: true, jam: null })
    await eventually(() => expect(c.events).toContainEqual({ type: 'jam.left', jamId, reason: 'ended' }))
    await eventually(async () => expect((await getSnapshot(third.userId)).state).toMatchObject({ playing: false }))
    expect((await getSnapshot(third.userId)).state.jam).toBeUndefined()
    // The host's own session plays on, as theirs again.
    expect((await getSnapshot(host.userId)).state).toMatchObject({ playing: true })
    expect((await getSnapshot(host.userId)).state.jam).toBeUndefined()
    expect(await jam(c, { action: 'join', jamId })).toEqual({ ok: false, error: 'jam_not_found' })
  })

  it('lets the host remove a member and invite people', async () => {
    const a = await device(host, 'host-phone-6')
    const b = await device(guest, 'guest-phone-6')
    const jamId = await started(a)
    await jam(b, { action: 'join', jamId })
    expect(await jam(a, { action: 'remove', userId: guest.userId })).toMatchObject({ ok: true })
    await eventually(() => expect(b.events).toContainEqual({ type: 'jam.left', jamId, reason: 'removed' }))
    await eventually(async () => expect((await getSnapshot(guest.userId)).state.jam).toBeUndefined())

    expect(await jam(a, { action: 'invite', userIds: [guest.userId] })).toMatchObject({ ok: true })
    const hostName = a.client.getSnapshot().session.jam!.members[0]!.name
    await eventually(() => expect(b.events).toContainEqual({ type: 'jam.invite', jamId, hostName }))
  })

  it('refuses joins that cannot be', async () => {
    const a = await device(host, 'host-phone-7')
    const b = await device(guest, 'guest-phone-7')
    expect(await jam(b, { action: 'join', jamId: 'no-such-jam-at-all' })).toEqual({ ok: false, error: 'jam_not_found' })
    const jamId = await started(a)
    const own = await started(b)
    expect(await jam(b, { action: 'join', jamId })).toEqual({ ok: false, error: 'jam_hosting' })
    expect(await jam(a, { action: 'join', jamId: own })).toEqual({ ok: false, error: 'jam_hosting' })
    expect(await jam(b, { action: 'end' })).toMatchObject({ ok: true })
    expect(await jam(b, { action: 'leave' })).toEqual({ ok: false, error: 'not_in_jam' })
    expect(await b.client.detach()).toEqual({ ok: true })
    expect(await jam(b, { action: 'join', jamId })).toEqual({ ok: false, error: 'jam_detached' })
  })

  it('keeps following the jam across a restart', async () => {
    const a = await device(host, 'host-phone-8')
    const b = await device(guest, 'guest-phone-8')
    a.client.dispatch(playAlbum())
    const jamId = await started(a)
    await jam(b, { action: 'join', jamId })
    await inStep(guest)
    for (const target of devices.splice(0)) {
      target.client.dispose()
      target.socket.disconnect()
    }
    await sessionsModule.stop!()

    // The member's session loads first, and catches up with the host's once that loads too.
    const back = await device(guest, 'guest-phone-8')
    await eventually(() => expect(back.client.getSnapshot().session.jam).toMatchObject({ id: jamId, role: 'member' }))
    await inStep(guest)
    const response = await app.inject({ method: 'GET', url: `/api/v1/jams/${jamId}`, headers: { authorization: `Bearer ${guest.token}` } })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ id: jamId, members: [{ userId: host.userId }, { userId: guest.userId }] })
  })

  it('sends members the jam\'s queue changes as diffs, and whole to clients that do not take them', async () => {
    const a = await device(host, 'host-phone-10')
    const b = await device(guest, 'guest-phone-10')
    a.client.dispatch(playAlbum())
    const jamId = await started(a)
    await jam(b, { action: 'join', jamId })
    await inStep(guest)
    // An older app of the guest's, whose hello does not accept queue operations.
    const old: SquirmySocket = connect(url, { path: '/socket.io', transports: ['websocket'], reconnection: false, auth: { token: guest.token } })
    const oldLog: string[] = []
    const opsLog: SessionQueueOps[] = []
    try {
      for (const event of ['session:queue', 'session:queueOps'] as const) old.on(event, () => oldLog.push(event))
      b.socket.on('session:queueOps', (update) => opsLog.push(update))
      const hello = await old.emitWithAck('session:hello', { device: { id: 'guest-old-10', name: 'old', kind: 'web' }, canPlay: false, detached: false })
      expect(hello.capabilities).toContain('queueOps')

      const track = album.tracks[2]!
      a.client.dispatch({ type: 'enqueue', placement: 'next', tracks: [{ trackId: track.recordingId, albumId: album.albumId, durationMs: 0 }] })
      await inStep(guest)
      b.client.dispatch({ type: 'enqueue', placement: 'last', tracks: [{ trackId: track.recordingId, albumId: album.albumId, durationMs: 0 }] })
      await eventually(async () => expect((await getSnapshot(host.userId)).queue.queue.at(-1)).toMatchObject({ addedBy: guest.userId }))
      await inStep(guest)
      const removed = (await getSnapshot(host.userId)).queue.queue[0]!.id
      a.client.dispatch({ type: 'removeFromQueue', entryId: removed })
      await eventually(async () => expect((await getSnapshot(guest.userId)).queue.queue.map((entry) => entry.id)).not.toContain(removed))
      await inStep(guest)

      // The guest's own queue versions, one change after another, and the same queue as the host's.
      const guestSnapshot = await getSnapshot(guest.userId)
      await eventually(() => expect(b.client.getSnapshot().queue).toEqual(guestSnapshot.queue))
      expect(guestSnapshot.queue.queue).toEqual((await getSnapshot(host.userId)).queue.queue)
      expect(opsLog.length).toBeGreaterThanOrEqual(3)
      for (const [index, update] of opsLog.entries()) {
        if (index > 0) expect(update.baseQueueVersion).toBe(opsLog[index - 1]!.queueVersion)
      }
      expect(opsLog.at(-1)!.queueVersion).toBe(guestSnapshot.queueVersion)
      // The older app got each as the whole queue, and never operations.
      await eventually(() => expect(oldLog.filter((event) => event === 'session:queue').length).toBeGreaterThanOrEqual(opsLog.length))
      expect(oldLog).not.toContain('session:queueOps')
      // A sync answers the guest's session, in step with the jam.
      const synced = await b.socket.emitWithAck('session:sync', {})
      expect(synced).toMatchObject({ ok: true, snapshot: { queueVersion: guestSnapshot.queueVersion, queue: guestSnapshot.queue } })
    } finally {
      old.disconnect()
    }
  })

  it('undoes the host\'s queue edits for everyone and leaves undo to the host', async () => {
    const a = await device(host, 'host-phone-11')
    const b = await device(guest, 'guest-phone-11')
    // Before joining, the guest has an edit of their own session to undo.
    b.client.dispatch(playAlbum())
    await eventually(async () => expect((await getSnapshot(guest.userId)).queue.queue).toHaveLength(2))
    const ownRemoved = (await getSnapshot(guest.userId)).queue.queue[0]!
    const ownEdit = b.client.dispatch({ type: 'removeFromQueue', entryId: ownRemoved.id })!
    await eventually(async () => expect((await getSnapshot(guest.userId)).queue.queue).toHaveLength(1))

    a.client.dispatch(playAlbum())
    await eventually(async () => expect((await getSnapshot(host.userId)).queue.queue).toHaveLength(2))
    const jamId = await started(a)
    await jam(b, { action: 'join', jamId })
    await inStep(guest)
    await eventually(() => expect(a.client.getSnapshot().canUndo).toBe(true))
    expect(b.client.getSnapshot().canUndo).toBe(false)

    const removed = (await getSnapshot(host.userId)).queue.queue[0]!
    const edit = a.client.dispatch({ type: 'removeFromQueue', entryId: removed.id })!
    await eventually(async () => expect((await getSnapshot(guest.userId)).queue.queue.map((entry) => entry.id)).not.toContain(removed.id))
    // Only the host undoes; the client does not even send a member's undo.
    expect(await rawCommand(b, { type: 'undo', commandId: edit })).toEqual({ ok: false, error: 'jam_host_only' })
    expect(b.client.dispatch({ type: 'undo', commandId: edit })).toBeNull()
    a.client.dispatch({ type: 'undo', commandId: edit })
    await eventually(async () => expect((await getSnapshot(guest.userId)).queue.queue[0]?.id).toBe(removed.id))
    await inStep(guest)
    await eventually(() => expect(b.client.getSnapshot().queue.queue[0]?.id).toBe(removed.id))

    // A member's additions are not on the host's stack: the host removes them instead.
    const track = album.tracks[2]!
    const added = b.client.dispatch({ type: 'enqueue', placement: 'last', tracks: [{ trackId: track.recordingId, albumId: album.albumId, durationMs: 0 }] })!
    await eventually(async () => expect((await getSnapshot(host.userId)).queue.queue.at(-1)).toMatchObject({ addedBy: guest.userId }))
    expect(await rawCommand(a, { type: 'undo', commandId: added })).toEqual({ ok: false, error: 'nothing_to_undo' })

    // Out of the jam, the guest's queue is the one the jam had: the edit made before joining is not undone into it.
    expect(await jam(b, { action: 'leave' })).toEqual({ ok: true, jam: null })
    await eventually(async () => expect((await getSnapshot(guest.userId)).state.jam).toBeUndefined())
    const left = (await getSnapshot(guest.userId)).queue
    expect(await rawCommand(b, { type: 'undo', commandId: ownEdit })).toEqual({ ok: false, error: 'nothing_to_undo' })
    expect((await getSnapshot(guest.userId)).queue).toEqual(left)
    await eventually(() => expect(b.client.getSnapshot().canUndo).toBe(true))
  })

  it('stops everyone when the host\'s sleep timer ends, and keeps a member\'s own timer out of the jam', async () => {
    const a = await device(host, 'host-phone-12')
    const b = await device(guest, 'guest-phone-12')
    b.client.dispatch(playAlbum())
    b.client.dispatch({ type: 'setSleepTimer', timer: { kind: 'queue' } })
    await eventually(async () => expect((await getSnapshot(guest.userId)).state.sleepTimer).toEqual({ kind: 'queue' }))
    a.client.dispatch(playAlbum())
    const jamId = await started(a)
    await jam(b, { action: 'join', jamId })
    await inStep(guest)
    expect((await getSnapshot(guest.userId)).state.sleepTimer).toBeUndefined()

    a.client.dispatch({ type: 'setSleepTimer', timer: { kind: 'time', durationMs: 200 } })
    await eventually(async () => expect((await getSnapshot(host.userId)).state.sleepTimer).toMatchObject({ kind: 'time' }))
    // The timer is the host's: members see the jam play on without one, and cannot set their own.
    expect((await getSnapshot(guest.userId)).state.sleepTimer).toBeUndefined()
    expect(await rawCommand(b, { type: 'setSleepTimer', timer: null })).toEqual({ ok: false, error: 'jam_unsupported' })
    time += 200
    await eventually(async () => expect((await getSnapshot(host.userId)).state).toMatchObject({ playing: false }))
    await inStep(guest)
    expect((await getSnapshot(guest.userId)).state.playing).toBe(false)
    await eventually(() => expect(b.engine.getStatus().state).toBe('paused'))
  })

  it('keeps each listener\'s signal path their own', async () => {
    const a = await device(host, 'host-phone-13')
    const b = await device(guest, 'guest-phone-13')
    a.client.dispatch(playAlbum())
    const jamId = await started(a)
    await jam(b, { action: 'join', jamId })
    await inStep(guest)
    const hostSignals: string[] = []
    const guestSignals: string[] = []
    a.socket.on('session:signal', (signal) => hostSignals.push(signal.deviceId))
    b.socket.on('session:signal', (signal) => guestSignals.push(signal.deviceId))
    // Each device reports what it plays; a change of song has both report again.
    a.client.dispatch({ type: 'next' })
    await inStep(guest)
    await eventually(() => {
      expect(a.client.getSnapshot().signal?.deviceId).toBe('host-phone-13')
      expect(b.client.getSnapshot().signal?.deviceId).toBe('guest-phone-13')
    })
    await eventually(() => expect(hostSignals.length * guestSignals.length).toBeGreaterThan(0))
    expect(new Set(hostSignals)).toEqual(new Set(['host-phone-13']))
    expect(new Set(guestSignals)).toEqual(new Set(['guest-phone-13']))
    // A new device of the guest's is told the guest's, not the host's.
    const other: SquirmySocket = connect(url, { path: '/socket.io', transports: ['websocket'], reconnection: false, auth: { token: guest.token } })
    try {
      const hello = await other.emitWithAck('session:hello', { device: { id: 'guest-other-13', name: 'other', kind: 'web' }, canPlay: false, detached: false })
      expect(hello.signal?.deviceId).toBe('guest-phone-13')
    } finally {
      other.disconnect()
    }
  })

  it('lets a member with explicit content off sit out the host\'s explicit songs, in step and without a play', async () => {
    const explicit = await createAlbum({ owned: true, tracks: [{ title: 'Clean', durationMs: 200_000 }, { title: 'Curse', durationMs: 200_000, explicit: true }] })
    await db.update(users).set({ explicitRestricted: true }).where(eq(users.id, guest.userId))
    const a = await device(host, 'host-phone-14')
    const b = await device(guest, 'guest-phone-14')
    a.client.dispatch({
      type: 'playTracks',
      tracks: explicit.tracks.map((track) => ({ trackId: track.recordingId, albumId: explicit.albumId, durationMs: 0 })),
      seed: 1,
      context: { type: 'album', id: explicit.albumId, title: explicit.title },
    })
    await eventually(async () => expect((await getSnapshot(host.userId)).state.playing).toBe(true))
    const jamId = await started(a)
    await jam(b, { action: 'join', jamId })
    await inStep(guest)

    time += 100_000
    a.client.dispatch({ type: 'next' })
    await eventually(async () => expect((await getSnapshot(host.userId)).state.current?.trackId).toBe(explicit.tracks[1]!.recordingId))
    await inStep(guest)
    // The server will not stream it to the member, whose device sits it out with the jam going on.
    const refused = await app.inject({ url: `/api/v1/tracks/${explicit.tracks[1]!.recordingId}/playback`, headers: { authorization: `Bearer ${guest.token}` } })
    expect(refused.statusCode).toBe(403)
    expect(refused.json()).toMatchObject({ error: { code: 'explicit_not_allowed' } })
    time += 100_000
    a.client.dispatch({ type: 'pause' })
    a.client.dispatch({ type: 'previous', restart: false })
    await eventually(async () => expect((await getSnapshot(host.userId)).state.current?.trackId).toBe(explicit.tracks[0]!.recordingId))
    await inStep(guest)

    // Each heard the clean song; only the host heard the explicit one.
    await eventually(async () => {
      const rows = await db.select({ userId: plays.userId, recordingId: plays.recordingId }).from(plays)
        .where(inArray(plays.recordingId, explicit.tracks.map((track) => track.recordingId)))
      expect(rows).toHaveLength(3)
      expect(rows).toEqual(expect.arrayContaining([
        { userId: host.userId, recordingId: explicit.tracks[0]!.recordingId },
        { userId: guest.userId, recordingId: explicit.tracks[0]!.recordingId },
        { userId: host.userId, recordingId: explicit.tracks[1]!.recordingId },
      ]))
    })
  })

  it('shows an invite link and whom to invite over HTTP', async () => {
    const a = await device(host, 'host-phone-9')
    const jamId = await started(a)
    const headers = { authorization: `Bearer ${guest.token}` }
    const preview = await app.inject({ method: 'GET', url: `/api/v1/jams/${jamId}`, headers })
    expect(preview.json()).toEqual({ id: jamId, hostName: host.name, members: [{ userId: host.userId, name: host.name }], trackId: null })
    expect((await app.inject({ method: 'GET', url: '/api/v1/jams/nope-nope-nope-nope', headers })).statusCode).toBe(404)
    expect((await app.inject({ method: 'GET', url: `/api/v1/jams/${jamId}` })).statusCode).toBe(401)
    const people = await app.inject({ method: 'GET', url: '/api/v1/jams/people', headers })
    const ids = (people.json() as { items: { userId: string }[] }).items.map((person) => person.userId)
    expect(ids).toContain(host.userId)
    expect(ids).not.toContain(guest.userId)
  })
})
