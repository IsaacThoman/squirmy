import { mkdtemp, realpath, rm } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createMockProvider, type MockProvider } from '@squirmy/adapter-mock'
import { FakeEngine, SessionClient } from '@squirmy/client-core'
import { createSocketTransport, type SquirmySocket } from '@squirmy/client-core/socket'
import { PlaybackDescriptor, type QueueEntry, type ServerEvent } from '@squirmy/contracts'
import { inArray } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { io as connect } from 'socket.io-client'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from '../../app.js'
import { db } from '../../database/client.js'
import { acquisitionJobs } from '../../database/schema.js'
import { jobs, startJobs, stopJobs } from '../../jobs/index.js'
import { newId } from '../../lib/ids.js'
import { updateServerSettings } from '../../lib/settings.js'
import { startRealtime } from '../../realtime/index.js'
import { body, signIn } from '../../test/api.js'
import { useTestDatabase } from '../../test/database.js'
import { createAlbum } from '../../test/factories.js'
import { acquisitionModule } from '../acquisition/index.js'
import { configureAcquisition } from '../acquisition/jobs.js'
import { updateAcquisitionPolicy } from '../acquisition/policy.js'
import { createProvider } from '../acquisition/providers.js'
import { importsModule } from '../imports/index.js'
import { libraryModule } from '../library/index.js'
import { insertRoot } from '../library/roots.js'
import { matchingModule } from '../matching/index.js'
import { sessionsModule } from './index.js'

/**
 * Sessions against the real acquisition module and the mock provider on a local port:
 * how many entries are fetched ahead and in which order, and what an outage looks like.
 */

async function eventually(check: () => void | Promise<void>, timeoutMs = 60_000): Promise<void> {
  const deadline = performance.now() + timeoutMs
  for (;;) {
    try {
      await check()
      return
    } catch (error) {
      if (performance.now() > deadline) throw error
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

type User = Awaited<ReturnType<typeof signIn>>
type Device = { client: SessionClient; socket: SquirmySocket; events: ServerEvent[] }

describe('sessions with on-demand tracks', () => {
  useTestDatabase()
  const secret = 'sessions-provider-secret'
  let app: FastifyInstance
  let url = ''
  let mock: MockProvider
  let rootDir = ''
  const devices: Device[] = []

  beforeAll(async () => {
    await updateServerSettings({ musicBrainzEnabled: false, deezerEnabled: false, coverArtArchiveEnabled: false, wikidataEnabled: false, lrclibEnabled: false })
    app = await buildApp()
    await sessionsModule.realtime!(await startRealtime(app))
    await app.listen({ host: '127.0.0.1', port: 0 })
    url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`
    for (const module of [libraryModule, matchingModule, importsModule, acquisitionModule]) await module.jobs!(jobs)
    await startJobs({ work: true })
    await acquisitionModule.start!({ role: 'api' })
    configureAcquisition({ pollMs: 100, slotWaitSeconds: 1 })

    rootDir = await realpath(await mkdtemp(path.join(tmpdir(), 'squirmy-sessions-acquired-')))
    const root = await insertRoot({ name: 'Acquired', path: rootDir, mode: 'managed', watch: false })
    await updateServerSettings({ importRootId: root.id })
    await updateAcquisitionPolicy({ deliveryBaseUrl: url })
    mock = createMockProvider({ secret, onError: () => {} })
    await createProvider({ name: 'Mock', baseUrl: await mock.listen(), secret, enabled: true, priority: 0 })
  }, 60_000)
  afterEach(async () => {
    for (const device of devices.splice(0)) {
      device.client.dispose()
      device.socket.disconnect()
    }
    await sessionsModule.stop!()
  })
  afterAll(async () => {
    await acquisitionModule.stop!()
    await stopJobs()
    await mock.close()
    await app.close()
    await rm(rootDir, { recursive: true, force: true })
  })

  async function device(user: User): Promise<Device> {
    const token = user.headers.authorization.slice('Bearer '.length)
    const socket: SquirmySocket = connect(url, { path: '/socket.io', transports: ['websocket'], reconnection: false, auth: { token } })
    const events: ServerEvent[] = []
    socket.on('event', (event) => events.push(event))
    const client = new SessionClient({
      transport: createSocketTransport(socket),
      device: { id: `device-${newId()}`, name: 'Test device', kind: 'web' },
      player: {
        engine: new FakeEngine(),
        resolvePlayback: async (entry: QueueEntry) => body(await app.inject({ url: `/api/v1/tracks/${entry.trackId}/playback`, headers: user.headers }), PlaybackDescriptor),
        baseUrl: url,
        normalization: 'off',
      },
      reportIntervalMs: 3_600_000,
    })
    client.start()
    const created = { client, socket, events }
    devices.push(created)
    await eventually(() => expect(client.getSnapshot().connection).toBe('online'), 5000)
    return created
  }

  async function remoteAlbum(count: number) {
    const album = await createAlbum({ tracks: Array.from({ length: count }, (_, index) => ({ title: `Far ${index + 1}`, durationMs: 2000 })) })
    return { albumId: album.albumId, ids: album.tracks.map((track) => track.recordingId) }
  }
  const play = (target: Device, album: { albumId: string; ids: string[] }) => target.client.dispatch({
    type: 'playTracks', tracks: album.ids.map((trackId) => ({ trackId, albumId: album.albumId, durationMs: 0 })), seed: 1,
  })
  const jobsFor = (ids: string[]) => db.select({ recordingId: acquisitionJobs.recordingId, status: acquisitionJobs.status }).from(acquisitionJobs)
    .where(inArray(acquisitionJobs.recordingId, ids)).orderBy(acquisitionJobs.id)

  it('pauses with one notice when the provider fails everything, keeping the rest of the queue', async () => {
    mock.settings.fail = true
    const album = await remoteAlbum(20)
    const phone = await device(await signIn({ canAcquire: true }))
    play(phone, album)
    await eventually(() => expect(phone.client.getSnapshot().session).toMatchObject({ playing: false, current: { state: 'failed' } }))
    const { session: { current }, queue: { queue } } = phone.client.getSnapshot()
    const at = album.ids.indexOf(current!.trackId)
    // Entries that failed as prefetches were passed quietly; the ones after the pause stay.
    expect(queue.length).toBeGreaterThan(0)
    expect(queue.map((entry) => entry.trackId)).toEqual(album.ids.slice(at + 1).filter((id) => queue.some((entry) => entry.trackId === id)))
    expect(queue.at(-1)!.trackId).toBe(album.ids.at(-1))
    await eventually(() => expect(phone.events.filter((event) => event.type === 'playback.unavailable')).toEqual([{ type: 'playback.unavailable', trackId: current!.trackId }]))

    // Nothing more is fetched or said until the user plays again. A request that was
    // already going out when playback paused may still land.
    await new Promise((resolve) => setTimeout(resolve, 500))
    const requested = (await jobsFor(album.ids)).length
    await new Promise((resolve) => setTimeout(resolve, 1500))
    expect((await jobsFor(album.ids)).length).toBe(requested)
    expect(phone.events.filter((event) => event.type === 'playback.unavailable')).toHaveLength(1)
    expect(phone.client.getSnapshot().session).toMatchObject({ playing: false, current: { trackId: current!.trackId } })
    mock.settings.fail = false
  }, 90_000)

  it('fetches the current entry and the next five, in queue order', async () => {
    // Slow enough that nothing finishes and moves the queue while the jobs are counted.
    mock.settings.delayMs = 20_000
    const album = await remoteAlbum(13)
    const phone = await device(await signIn({ canAcquire: true }))
    play(phone, album)
    await eventually(async () => expect((await jobsFor(album.ids)).map((job) => job.recordingId)).toEqual(album.ids.slice(0, 6)), 10_000)
    await new Promise((resolve) => setTimeout(resolve, 500))
    expect((await jobsFor(album.ids)).map((job) => job.recordingId)).toEqual(album.ids.slice(0, 6))
    expect(phone.client.getSnapshot().session.current).toMatchObject({ trackId: album.ids[0], state: 'preparing' })
  }, 30_000)
})
