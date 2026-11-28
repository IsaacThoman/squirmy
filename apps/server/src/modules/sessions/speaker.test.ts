import { execFile } from 'node:child_process'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { SessionClient } from '@squirmy/client-core'
import { createSocketTransport, type SquirmySocket } from '@squirmy/client-core/socket'
import type { SessionCommand } from '@squirmy/contracts'
import { FakeSink, ffmpegDecoder, outputFormat, PcmEngine, startSpeaker, type Speaker } from '@squirmy/speaker'
import { eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { io as connect } from 'socket.io-client'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { buildApp } from '../../app.js'
import { db } from '../../database/client.js'
import { mediaFiles, recordings } from '../../database/schema.js'
import { startRealtime } from '../../realtime/index.js'
import { makeSplitTone } from '../../test/audio.js'
import { useTestDatabase } from '../../test/database.js'
import { createAlbum, createLibraryRoot, createUser } from '../../test/factories.js'
import { createSession } from '../auth/service.js'
import { measureLoudness } from '../loudness/measure.js'
import { sessionsModule } from './index.js'
import { configureSessions, getSnapshot } from './service.js'

const exec = promisify(execFile)

async function eventually(check: () => void | Promise<void>, timeoutMs = 10_000): Promise<void> {
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

/**
 * End to end: the speaker daemon's own code (`startSpeaker`, `PcmEngine`, the ffmpeg decoder)
 * against the real server, with a fake sound card. A phone's `SessionClient` plays an album and
 * sends it to the speaker. The server, the clients and the speaker share one fake clock, which
 * the test moves; ffmpeg decodes the server's real streams as fast as it can.
 */
describe('a Squirmy speaker', () => {
  useTestDatabase()
  let app: FastifyInstance
  let url = ''
  let root = ''
  let rootId = ''
  let time = 0
  const now = () => time
  const running: { stop(): void }[] = []

  beforeAll(async () => {
    app = await buildApp()
    await sessionsModule.realtime!(await startRealtime(app))
    await app.listen({ host: '127.0.0.1', port: 0 })
    url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`
    root = await mkdtemp(path.join(tmpdir(), 'squirmy-speaker-'))
    rootId = (await createLibraryRoot({ path: root })).id
  })
  beforeEach(() => {
    time = 1_800_000_000_000
    configureSessions({ now, deviceGraceMs: 20_000 })
  })
  afterEach(async () => {
    for (const item of running.splice(0)) item.stop()
    await sessionsModule.stop!()
  })
  afterAll(async () => {
    await app.close()
    await rm(root, { recursive: true, force: true })
  })

  /** Two tracks cut from one chirp at a frame no codec's packets line up with, measured as the library would. */
  let albums = 0
  async function splitAlbum(format: 'flac' | 'alac') {
    const fixture = await makeSplitTone(path.join(root, `${format}-${++albums}`), { format })
    const album = await createAlbum({ owned: true, rootId, tracks: [{ title: 'First' }, { title: 'Second' }] })
    for (const [index, file] of fixture.halves.entries()) {
      const measured = await measureLoudness(file)
      const durationMs = Math.round(measured.decodedFrames * 1000 / fixture.rate)
      await db.update(mediaFiles).set({
        relPath: path.relative(root, file), size: (await stat(file)).size,
        container: format === 'alac' ? 'mp4' : 'flac', codec: format, lossless: true, sampleRate: fixture.rate, bitDepth: 24, durationMs,
        decodedFrames: measured.decodedFrames, decodedRate: measured.decodedRate, primingFrames: measured.primingFrames, paddingFrames: measured.paddingFrames,
      }).where(eq(mediaFiles.id, album.tracks[index]!.fileId!))
      await db.update(recordings).set({ durationMs }).where(eq(recordings.id, album.tracks[index]!.recordingId))
    }
    // What the two halves are together, decoded as the speaker writes it.
    const { stdout } = await exec(process.env.FFMPEG_PATH ?? 'ffmpeg', ['-v', 'error', '-i', fixture.whole, '-ac', '2', '-c:a', 'pcm_s32le', '-f', 's32le', '-'], { encoding: 'buffer', maxBuffer: 16 * 1024 * 1024 })
    return { album, fixture, whole: Buffer.from(stdout) }
  }

  async function signIn(kind: string) {
    const user = await createUser()
    const token = (await createSession(db, { userId: user.id, clientKind: kind })).token
    return { user, token }
  }

  function speaker(token: string, id: string): { speaker: Speaker; sink: FakeSink } {
    const sink = new FakeSink(now)
    const engine = new PcmEngine({
      decoder: ffmpegDecoder(),
      sink,
      formatFor: (media) => outputFormat({ rate: 'source', maxRate: 192_000, encoding: 's32le' }, media),
      now,
      // A tick for each step of the test's clock (see `play`).
      tickMs: 1,
      // The test compares samples from the very first one; the speaker's de-click fade would change a few.
      fadeInMs: 0,
    })
    const created = startSpeaker({
      server: url, token, device: { id, name: 'Living room', kind: 'speaker' }, engine, now,
      onSignedOut: () => {}, onLog: () => {}, reportIntervalMs: 3_600_000,
      socket: (server, auth) => connect(server, { path: '/socket.io', transports: ['websocket'], reconnection: false, autoConnect: false, auth: { token: auth } }),
    })
    running.push(created)
    return { speaker: created, sink }
  }

  function phone(token: string): SessionClient {
    const socket: SquirmySocket = connect(url, { path: '/socket.io', transports: ['websocket'], reconnection: false, autoConnect: false, auth: { token } })
    const client = new SessionClient({ transport: createSocketTransport(socket), device: { id: 'phone-speaker-test', name: 'Phone', kind: 'ios' }, now })
    client.start()
    socket.connect()
    running.push({ stop: () => { client.dispose(); socket.disconnect() } })
    return client
  }

  /** Moves the shared clock in small steps, letting the real decoders and sockets keep up. */
  async function play(ms: number) {
    for (let elapsed = 0; elapsed < ms; elapsed += 20) {
      time += 20
      await new Promise((resolve) => setTimeout(resolve, 2))
    }
  }

  for (const format of ['flac', 'alac'] as const) {
    it(`appears as a speaker, takes the session and plays the queue gaplessly (${format === 'flac' ? 'originals' : 'flac_mp4'})`, async () => {
      const { album, whole } = await splitAlbum(format)
      const { user, token } = await signIn('speaker')
      const { speaker: living, sink } = speaker(token, `speaker-${format}-test`)
      const remote = phone(token)
      await eventually(() => expect(remote.getSnapshot().connection).toBe('online'))
      await eventually(() => expect(remote.getSnapshot().devices).toContainEqual(expect.objectContaining({
        id: `speaker-${format}-test`, name: 'Living room', kind: 'speaker', canPlay: true, isActive: false,
      })))

      const playAlbum: SessionCommand = {
        type: 'playTracks',
        tracks: album.tracks.map((track) => ({ trackId: track.recordingId, albumId: album.albumId, durationMs: 0 })),
        seed: 1,
        context: { type: 'album', id: album.albumId, title: album.title },
      }
      // Nothing after the album: autoplay would go on to the other tests' albums.
      remote.dispatch({ type: 'setAutoplay', value: false })
      remote.dispatch(playAlbum)
      remote.dispatch({ type: 'transfer', deviceId: `speaker-${format}-test`, play: true })
      await eventually(() => expect(living.client.getSnapshot().isActiveDevice).toBe(true))
      await eventually(() => expect(sink.isOpen).toBe(true))
      const first = remote.getSnapshot().session.current!

      // 133,077 + 88,533 frames at 44.1 kHz: five seconds, with room to spare.
      await play(1000)
      expect(remote.getSnapshot().session).toMatchObject({ playing: true, current: { id: first.id } })
      await play(5500)
      await eventually(async () => {
        const { state } = await getSnapshot(user.id)
        expect(state.current?.trackId).toBe(album.tracks[1]!.recordingId)
        expect(state.playing).toBe(false)
      })
      const heard = sink.heard()
      // Every sample of both songs, back to back, bit for bit what the uncut chirp decodes to.
      expect(heard.length).toBe(whole.length)
      expect(heard.equals(whole)).toBe(true)
      // One stream from the first sample to the last.
      expect(sink.opens).toEqual([{ sampleRate: 44_100, channels: 2, encoding: 's32le' }])
    })
  }

  it('pauses and seeks when the phone says so', async () => {
    const { album } = await splitAlbum('flac')
    const { token } = await signIn('speaker')
    const { speaker: living, sink } = speaker(token, 'speaker-control-test')
    const remote = phone(token)
    await eventually(() => expect(remote.getSnapshot().devices.some((device) => device.kind === 'speaker')).toBe(true))
    remote.dispatch({ type: 'setAutoplay', value: false })
    remote.dispatch({
      type: 'playTracks', tracks: album.tracks.map((track) => ({ trackId: track.recordingId, albumId: album.albumId, durationMs: 0 })),
      seed: 1, context: { type: 'album', id: album.albumId, title: album.title },
    })
    remote.dispatch({ type: 'transfer', deviceId: 'speaker-control-test', play: true })
    await eventually(() => expect(living.client.getSnapshot().isActiveDevice).toBe(true))
    await eventually(() => expect(sink.isOpen).toBe(true))
    await play(500)
    remote.dispatch({ type: 'pause' })
    await eventually(() => expect(sink.isOpen).toBe(false))
    const paused = living.client.getPositionMs()
    await play(2000)
    expect(living.client.getPositionMs()).toBe(paused)
    remote.dispatch({ type: 'seek', positionMs: 2000 })
    remote.dispatch({ type: 'play' })
    await eventually(() => expect(sink.isOpen).toBe(true))
    await play(400)
    await eventually(() => expect(remote.getPositionMs()).toBeGreaterThanOrEqual(2300))
    expect(remote.getPositionMs()).toBeLessThan(2600)
  })
})
