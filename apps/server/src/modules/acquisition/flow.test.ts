import { access, mkdtemp, readdir, realpath, rm } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createMockProvider, type MockProvider } from '@squirmy/adapter-mock'
import { FakeEngine, SessionClient } from '@squirmy/client-core'
import { createSocketTransport, type SquirmySocket } from '@squirmy/client-core/socket'
import {
  AcquireResponse, AcquisitionProviderList, AcquisitionUsage, ImportList, LibraryStats, MatchReviewList, PlaybackDescriptor, TrackSummary, type QueueEntry, type ServerEvent,
} from '@squirmy/contracts'
import { deliver } from '@squirmy/provider-kit'
import { and, eq, inArray, isNull, sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { io as connect } from 'socket.io-client'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildApp } from '../../app.js'
import { db } from '../../database/client.js'
import { acquisitionJobs, acquisitionMisses, imports, likes, matchReviews, mediaFiles, recordings } from '../../database/schema.js'
import { drainJobs, jobs, startJobs, stopJobs } from '../../jobs/index.js'
import { newId } from '../../lib/ids.js'
import { updateServerSettings } from '../../lib/settings.js'
import { startRealtime } from '../../realtime/index.js'
import { body, errorCode, signIn } from '../../test/api.js'
import { makeTone } from '../../test/audio.js'
import { useTestDatabase } from '../../test/database.js'
import { createAlbum } from '../../test/factories.js'
import { trackAvailability } from '../catalog/availability.js'
import { resolveOne } from '../catalog/redirects.js'
import { importsModule } from '../imports/index.js'
import { libraryModule } from '../library/index.js'
import { insertRoot } from '../library/roots.js'
import { matchingModule } from '../matching/index.js'
import { sessionsModule } from '../sessions/index.js'
import { requestRecording } from './coverage.js'
import { acquisitionModule } from './index.js'
import { configureAcquisition, finishJob, sweepJobs } from './jobs.js'
import { applyOutcome, recentOutcome } from './outcomes.js'
import { updateAcquisitionPolicy } from './policy.js'
import { createProvider, updateProvider } from './providers.js'

/**
 * The whole on-demand path against the mock provider on a local port: availability, a
 * session entry going from `preparing` to `ready` (or `failed`), the job's life cycle, the
 * delivery endpoints and the import pipeline. MusicBrainz and the other metadata sources
 * are off, so delivered files are identified from their tags only.
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
type Device = { client: SessionClient; engine: FakeEngine; socket: SquirmySocket; events: ServerEvent[] }

describe('acquisition end to end', () => {
  useTestDatabase()
  const secret = 'flow-provider-secret'
  let app: FastifyInstance
  let url = ''
  let mock: MockProvider
  let providerId = ''
  let rootDir = ''
  let fixtures = ''
  let fan: User
  const devices: Device[] = []

  beforeAll(async () => {
    await updateServerSettings({ musicBrainzEnabled: false, deezerEnabled: false, coverArtArchiveEnabled: false, wikidataEnabled: false, lrclibEnabled: false })
    app = await buildApp()
    await sessionsModule.realtime!(await startRealtime(app))
    await app.listen({ host: '127.0.0.1', port: 0 })
    url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`
    for (const module of [libraryModule, matchingModule, importsModule, acquisitionModule]) await module.jobs!(jobs)
    await startJobs({ work: true })
    // The API half: outcomes reach the sessions. The sweep is run by hand.
    await acquisitionModule.start!({ role: 'api' })
    configureAcquisition({ pollMs: 100 })

    rootDir = await realpath(await mkdtemp(path.join(tmpdir(), 'squirmy-acquired-')))
    fixtures = await mkdtemp(path.join(tmpdir(), 'squirmy-acquisition-fixtures-'))
    const root = await insertRoot({ name: 'Acquired', path: rootDir, mode: 'managed', watch: false })
    await updateServerSettings({ importRootId: root.id })
    await updateAcquisitionPolicy({ deliveryBaseUrl: url })

    mock = createMockProvider({ secret, onError: () => {} })
    const created = await createProvider({ name: 'Mock', baseUrl: await mock.listen(), secret, enabled: true, priority: 0 })
    providerId = created.id
    fan = await signIn({ canAcquire: true })
  }, 60_000)

  beforeEach(() => {
    Object.assign(mock.settings, { delayMs: 0, fail: false, wrongFile: false, priced: false })
  })
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
    await rm(fixtures, { recursive: true, force: true })
  })

  async function device(user: User): Promise<Device> {
    const token = user.headers.authorization.slice('Bearer '.length)
    const socket: SquirmySocket = connect(url, { path: '/socket.io', transports: ['websocket'], reconnection: false, auth: { token } })
    const events: ServerEvent[] = []
    socket.on('event', (event) => events.push(event))
    const engine = new FakeEngine()
    const client = new SessionClient({
      transport: createSocketTransport(socket),
      device: { id: `device-${newId()}`, name: 'Test device', kind: 'web' },
      player: {
        engine,
        // The real descriptor, so the requested id must play after any merge.
        resolvePlayback: async (entry: QueueEntry) => body(await app.inject({ url: `/api/v1/tracks/${entry.trackId}/playback`, headers: user.headers }), PlaybackDescriptor),
        baseUrl: url,
        normalization: 'off',
      },
      reportIntervalMs: 3_600_000,
    })
    client.start()
    const created = { client, engine, socket, events }
    devices.push(created)
    await eventually(() => expect(client.getSnapshot().connection).toBe('online'), 5000)
    return created
  }

  const play = (target: Device, trackIds: string[], albumId: string) => target.client.dispatch({
    type: 'playTracks', tracks: trackIds.map((trackId) => ({ trackId, albumId, durationMs: 0 })), seed: 1,
  })
  const summaryOf = async (id: string) => body(await app.inject({ url: `/api/v1/tracks/${id}`, headers: fan.headers }), TrackSummary)
  const jobsFor = (recordingId: string) => db.select().from(acquisitionJobs).where(sql`${acquisitionJobs.recordingIds} @> array[${recordingId}]::uuid[]`).orderBy(acquisitionJobs.id)
  const acquire = (user: User, recordingId: string) => app.inject({ method: 'POST', url: `/api/v1/tracks/${recordingId}/acquire`, headers: user.headers })
  /**
   * Waits until the recording's jobs have ended and the background work they started
   * (filing, discarding, eviction) is done. A job that has not been created yet does not
   * count as ended.
   */
  const settle = async (recordingId: string) => {
    await eventually(async () => {
      const found = await jobsFor(recordingId)
      expect(found.length > 0 && found.every((job) => job.completedAt !== null)).toBe(true)
    })
    await drainJobs()
  }

  it('turns a gray track on demand, fetches it when played and plays it once it is imported', async () => {
    const album = await createAlbum({ title: 'Never Owned', tracks: [{ title: 'Quiet Song', durationMs: 4000 }, { title: 'Another One', durationMs: 3000 }] })
    const wanted = album.tracks[0]!.recordingId
    const summary = async () => body(await app.inject({ url: `/api/v1/tracks/${wanted}`, headers: fan.headers }), TrackSummary)
    await updateProvider(providerId, { enabled: false })
    expect((await summary()).availability).toBe('none')

    await updateProvider(providerId, { enabled: true })
    expect((await summary()).availability).toBe('on_demand')

    const phone = await device(fan)
    mock.settings.delayMs = 300
    const started = Date.now()
    play(phone, [wanted], album.albumId)
    await eventually(() => expect(phone.client.getSnapshot().session.current).toMatchObject({ trackId: wanted, state: 'preparing' }), 5000)
    expect(phone.client.getSnapshot().session.stalled).toBe(true)

    await eventually(() => expect(phone.client.getSnapshot().session.current).toMatchObject({ trackId: wanted, state: 'ready' }))
    await eventually(() => expect(phone.engine.getStatus().state).toBe('playing'), 5000)
    expect(Date.now() - started).toBeLessThan(60_000)

    await settle(wanted)
    const [job] = await jobsFor(wanted)
    expect(job).toMatchObject({
      status: 'completed', error: null, providerId, requestedBy: fan.id, recordingId: wanted, albumId: album.albumId, recordingIds: [wanted],
      idempotencyKey: `recording:${wanted}:${job!.id}`,
    })
    expect(job!.providerJobId).toBe(job!.id)
    expect(job!.uploadTokenHash).toMatch(/^[0-9a-f]{64}$/)
    expect(job!.offer).toMatchObject({ format: 'flac', lossless: true })

    const files = await db.select().from(mediaFiles).where(eq(mediaFiles.importId, job!.importId!))
    expect(files).toHaveLength(1)
    expect(files[0]).toMatchObject({ source: `provider:${providerId}`, durationMs: 4000 })
    expect(await resolveOne('recordings', files[0]!.recordingId!)).toBe(wanted)
    const [delivered] = await db.select().from(imports).where(eq(imports.id, job!.importId!))
    expect(delivered).toMatchObject({ kind: 'acquisition', status: 'completed', acquisitionJobId: job!.id, userId: fan.id })

    expect((await summary()).availability).toBe('server')
    // Events reach the socket after the job row is written.
    const statuses = () => phone.events.flatMap((event) => event.type === 'acquisition.updated' && event.jobId === job!.id ? [event.status] : [])
    await eventually(() => expect(statuses()).toEqual(['resolving', 'queued', 'downloading', 'importing', 'completed']), 5000)
    expect(phone.engine.calls.filter(([method]) => method === 'load')).toHaveLength(1)
  })

  /**
   * Turns MusicBrainz on and answers its requests (with nothing found) only once the
   * returned function is called, so identification of a delivery waits until then.
   */
  async function holdIdentification(): Promise<() => Promise<void>> {
    let open!: () => void
    const gate = new Promise<void>((resolve) => {
      open = resolve
    })
    const realFetch = globalThis.fetch
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const target = input instanceof Request ? input.url : String(input)
      if (!new URL(target).hostname.endsWith('musicbrainz.org')) return realFetch(input, init)
      await gate
      return Response.json({})
    })
    await updateServerSettings({ musicBrainzEnabled: true })
    return async () => {
      open()
      try {
        await drainJobs()
      } finally {
        spy.mockRestore()
        await updateServerSettings({ musicBrainzEnabled: false })
      }
    }
  }

  it('plays an on-demand track as soon as its file is usable, while identification is still running', async () => {
    const album = await createAlbum({ title: 'Slow To Identify', tracks: [{ title: 'Early Bird', durationMs: 4000 }] })
    const wanted = album.tracks[0]!.recordingId
    const release = await holdIdentification()
    let elapsed: number
    try {
      // A user of their own: the fan's session still names the first test's device as active.
      const phone = await device(await signIn({ canAcquire: true }))
      const started = performance.now()
      play(phone, [wanted], album.albumId)
      await eventually(() => expect(phone.client.getSnapshot().session.current).toMatchObject({ trackId: wanted, state: 'preparing' }), 5000)
      await eventually(() => expect(phone.client.getSnapshot().session.current).toMatchObject({ trackId: wanted, state: 'ready' }), 20_000)
      elapsed = performance.now() - started
      await eventually(() => expect(phone.engine.getStatus().state).toBe('playing'), 5000)

      const [job] = await jobsFor(wanted)
      expect(job!.status).toBe('importing')
      const [identifying] = await db.select().from(imports).where(eq(imports.id, job!.importId!))
      expect(identifying).toMatchObject({ status: 'processing', step: 'identifying' })
      expect((await summaryOf(wanted)).availability).toBe('server')
    } finally {
      await release()
    }
    await settle(wanted)
    expect((await jobsFor(wanted))[0]).toMatchObject({ status: 'completed', error: null })
    expect(elapsed).toBeLessThan(10_000)
  })

  it('fails future plays of a track identification later finds to be another recording, and deletes its file', async () => {
    const album = await createAlbum({ title: 'Mistaken Identity', tracks: [{ title: 'Lookalike', durationMs: 4000, mbid: crypto.randomUUID() }] })
    const wanted = album.tracks[0]!.recordingId
    const [other] = await db.insert(recordings).values({
      id: newId(), mbid: crypto.randomUUID(), title: 'Lookalike (Live)', artistCredit: album.artist.name, titleKey: 'lookalike live', matchKey: 'x|lookalike live',
    }).returning()
    const release = await holdIdentification()
    let phone: Device
    try {
      phone = await device(await signIn({ canAcquire: true }))
      play(phone, [wanted, wanted], album.albumId)
      await eventually(() => expect(phone.client.getSnapshot().session.current).toMatchObject({ trackId: wanted, state: 'preparing' }), 5000)
      await eventually(() => expect(phone.client.getSnapshot().session.current).toMatchObject({ trackId: wanted, state: 'ready' }), 20_000)
      await eventually(() => expect(phone.engine.getStatus().state).toBe('playing'), 5000)
      const [job] = await jobsFor(wanted)
      const delivered = () => db.select().from(mediaFiles).where(sql`starts_with(${mediaFiles.relPath}, ${`_Incoming/${job!.importId}/`})`)
      // A delivery of one file is placed on its album while it is identified. Relinking it
      // while that runs would be overwritten by the placement, so wait for it to be done.
      await eventually(async () => expect(await delivered()).toMatchObject([{ recordingId: wanted, matchSource: 'request', matchStatus: 'matched' }]), 10_000)
      // What matching does when it decides the file is another recording.
      const linked = await db.update(mediaFiles).set({ recordingId: other!.id, matchStatus: 'matched' })
        .where(sql`starts_with(${mediaFiles.relPath}, ${`_Incoming/${job!.importId}/`})`).returning()
      expect(linked).toHaveLength(1)
    } finally {
      await release()
    }
    await settle(wanted)
    const [job] = await jobsFor(wanted)
    expect(job).toMatchObject({ status: 'failed', error: 'Identification found the delivery is a different recording after it had started playing' })
    // Another song under the requested track's name is not kept for anyone to play.
    expect(await db.select().from(mediaFiles).where(eq(mediaFiles.recordingId, other!.id))).toEqual([])
    expect(await db.select().from(acquisitionMisses).where(eq(acquisitionMisses.entityId, wanted))).toHaveLength(1)
    await eventually(() => expect(phone.client.getSnapshot().queue.queue[0]).toMatchObject({ trackId: wanted, state: 'failed' }), 5000)
    expect(phone.client.getSnapshot().session.current).toMatchObject({ trackId: wanted, state: 'ready' })
    expect(phone.engine.getStatus().state).toBe('playing')
  })

  it('collapses requests for the same track into one job', async () => {
    const album = await createAlbum({ tracks: [{ title: 'Popular', durationMs: 3000 }] })
    const wanted = album.tracks[0]!.recordingId
    const other = await signIn({ canAcquire: true })
    mock.settings.delayMs = 500
    const responses = await Promise.all([acquire(fan, wanted), acquire(other, wanted), acquire(fan, wanted)])
    const ids = responses.map((response) => body(response, AcquireResponse, 202).items[0]!.id)
    expect(new Set(ids).size).toBe(1)
    expect(await jobsFor(wanted)).toHaveLength(1)
    await settle(wanted)
    expect((await jobsFor(wanted))[0]!.status).toBe('completed')
    expect(errorCode(await acquire(fan, wanted), 409)).toBe('already_available')
  })

  it('never takes a priced offer', async () => {
    const album = await createAlbum({ tracks: [{ title: 'For Sale', durationMs: 3000 }] })
    const wanted = album.tracks[0]!.recordingId
    mock.settings.priced = true
    body(await acquire(fan, wanted), AcquireResponse, 202)
    await settle(wanted)
    const [job] = await jobsFor(wanted)
    expect(job).toMatchObject({ status: 'failed', error: 'No provider has a free offer for it', importId: null })
    expect(await db.select().from(acquisitionMisses).where(eq(acquisitionMisses.entityId, wanted))).toHaveLength(1)
    expect((await trackAvailability([wanted])).get(wanted)).toBe('none')
  })

  it('refuses users who may not fetch, and their session skips the track', async () => {
    const album = await createAlbum({ tracks: [{ title: 'Forbidden', durationMs: 3000 }, { title: 'Owned', durationMs: 3000 }], owned: [1] })
    const [forbidden, owned] = album.tracks.map((track) => track.recordingId) as [string, string]
    const member = await signIn()
    expect(errorCode(await acquire(member, forbidden), 403)).toBe('acquire_not_allowed')

    const phone = await device(member)
    play(phone, [forbidden, owned], album.albumId)
    await eventually(() => expect(phone.client.getSnapshot().session.current).toMatchObject({ trackId: owned, state: 'ready' }), 10_000)
    expect(phone.client.getSnapshot().queue.history).toEqual([])
    expect(await jobsFor(forbidden)).toEqual([])
  })

  it('fails a delivery that is not what was asked for, deletes it, records a miss and skips the entry', async () => {
    const album = await createAlbum({ tracks: [{ title: 'The Right One', durationMs: 4000 }, { title: 'Owned Next', durationMs: 3000 }], owned: [1] })
    const [wanted, owned] = album.tracks.map((track) => track.recordingId) as [string, string]
    mock.settings.wrongFile = true
    const phone = await device(fan)
    play(phone, [wanted, owned], album.albumId)
    await eventually(() => expect(phone.client.getSnapshot().session.current).toMatchObject({ trackId: wanted, state: 'preparing' }), 5000)
    await eventually(() => expect(phone.client.getSnapshot().session.current).toMatchObject({ trackId: owned }))

    await eventually(async () => expect((await jobsFor(wanted))[0]).toMatchObject({ status: 'failed', error: 'The delivered files are not what was asked for' }))
    const [job] = await jobsFor(wanted)
    // Nothing of it is kept, on disk or in the library, and nothing waits for review. The
    // rows go first and the folder after them, both after the job has ended.
    await eventually(async () => expect(await db.select().from(mediaFiles).where(eq(mediaFiles.importId, job!.importId!))).toEqual([]))
    await eventually(async () => expect(await readdir(path.join(rootDir, '_Incoming')).catch(() => [])).not.toContain(job!.importId))
    await drainJobs()
    expect(await db.select().from(matchReviews)).toEqual([])
    const [requested] = await db.select().from(recordings).where(eq(recordings.id, wanted))
    expect(requested!.mergedIntoId).toBeNull()
    expect(await db.select().from(acquisitionMisses).where(and(eq(acquisitionMisses.providerId, providerId), eq(acquisitionMisses.entityId, wanted)))).toHaveLength(1)
    expect((await trackAvailability([wanted])).get(wanted)).toBe('none')
  })

  it('times out a provider that never delivers, and refuses its late delivery', async () => {
    await updateAcquisitionPolicy({ timeoutSeconds: 30 })
    const album = await createAlbum({ tracks: [{ title: 'Slowpoke', durationMs: 3000 }] })
    const wanted = album.tracks[0]!.recordingId
    mock.settings.delayMs = 120_000
    const phone = await device(fan)
    play(phone, [wanted], album.albumId)
    await eventually(async () => expect((await jobsFor(wanted))[0]?.status).toBe('queued'), 10_000)

    await sweepJobs(Date.now() + 31_000)
    const [job] = await jobsFor(wanted)
    expect(job).toMatchObject({ status: 'failed', error: 'Nothing was delivered within 30 seconds' })
    // The entry failed and the session moved past it.
    await eventually(() => expect(phone.client.getSnapshot().session.current?.trackId).not.toBe(wanted), 5000)

    const late = await makeTone(fixtures, { path: 'late.flac', durationSec: 1, frequency: 700, tags: { title: 'Slowpoke' } })
    await expect(deliver(mock.jobs.get(job!.id)!, [{ path: late, name: 'late.flac' }])).rejects.toThrow(/409.*job_not_active/)
    await updateAcquisitionPolicy({ timeoutSeconds: 900 })
  })

  it('accepts a delivery token only for its own job, and fails the job on an oversized file', async () => {
    const album = await createAlbum({ tracks: [{ title: 'First Token', durationMs: 3000 }, { title: 'Second Token', durationMs: 3000 }] })
    const [first, second] = album.tracks.map((track) => track.recordingId) as [string, string]
    mock.settings.delayMs = 120_000
    body(await acquire(fan, first), AcquireResponse, 202)
    body(await acquire(fan, second), AcquireResponse, 202)
    await eventually(async () => expect([(await jobsFor(first))[0]?.status, (await jobsFor(second))[0]?.status]).toEqual(['queued', 'queued']), 10_000)
    const [firstJob] = await jobsFor(first)
    const [secondJob] = await jobsFor(second)
    const firstDelivery = mock.jobs.get(firstJob!.id)!.delivery
    const secondDelivery = mock.jobs.get(secondJob!.id)!.delivery
    expect(firstDelivery.uploadUrl).toBe(`${url}/api/v1/acquisition/deliveries/${firstJob!.id}/files`)

    const complete = (target: string, token?: string) => app.inject({
      method: 'POST', url: `/api/v1/acquisition/deliveries/${target}/complete`, payload: { status: 'completed' },
      headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
    })
    expect(errorCode(await complete(secondJob!.id, firstDelivery.token), 401)).toBe('invalid_delivery_token')
    expect(errorCode(await complete(secondJob!.id), 401)).toBe('invalid_delivery_token')
    expect(errorCode(await complete(newId(), secondDelivery.token), 401)).toBe('invalid_delivery_token')
    // A session token is not a delivery token either.
    expect(errorCode(await complete(secondJob!.id, fan.headers.authorization.slice(7)), 401)).toBe('invalid_delivery_token')

    await updateAcquisitionPolicy({ maxFileBytes: 1000 })
    const big = await makeTone(fixtures, { path: 'big.flac', durationSec: 2, frequency: 800, tags: { title: 'First Token' } })
    await expect(deliver({ delivery: firstDelivery }, [{ path: big, name: 'big.flac' }])).rejects.toThrow(/413.*file_too_large/)
    await eventually(async () => expect((await jobsFor(first))[0]).toMatchObject({ status: 'failed' }), 10_000)
    const [failed] = await jobsFor(first)
    expect(failed!.error).toMatch(/over the limit: Files may be at most 1000 bytes/)
    await eventually(async () => expect((await db.select().from(imports).where(eq(imports.id, failed!.importId!)))[0]).toMatchObject({ status: 'failed', receivedFiles: 0 }), 10_000)
    await updateAcquisitionPolicy({ maxFileBytes: 500 * 1024 ** 2 })

    // The other job is untouched and still takes its own delivery.
    const small = await makeTone(fixtures, { path: 'second.flac', durationSec: 3, frequency: 610, tags: { title: 'Second Token', artist: album.artist.name, album: album.title } })
    await deliver({ delivery: secondDelivery }, [{ path: small, name: 'second.flac' }])
    await settle(second)
    expect((await jobsFor(second))[0]).toMatchObject({ status: 'completed' })
  })

  it('holds a delivery to what its job may receive: no empty audio, and no more files than the request needs', async () => {
    const album = await createAlbum({ tracks: [{ title: 'Budgeted', durationMs: 3000 }] })
    const wanted = album.tracks[0]!.recordingId
    mock.settings.delayMs = 120_000
    body(await acquire(fan, wanted), AcquireResponse, 202)
    await eventually(async () => expect((await jobsFor(wanted))[0]?.status).toBe('queued'), 10_000)
    const [job] = await jobsFor(wanted)
    const { delivery } = mock.jobs.get(job!.id)!
    const upload = async (name: string, content: string) => {
      const form = new FormData()
      form.append('relativePath', name)
      form.append('file', new Blob([content]), name)
      const response = await fetch(delivery.uploadUrl, { method: 'POST', headers: { authorization: `Bearer ${delivery.token}` }, body: form })
      return { status: response.status, body: await response.json() as { files?: { status: string; reason: string | null }[]; error?: { code: string } } }
    }

    expect(await upload('Empty.flac', '')).toMatchObject({ status: 200, body: { files: [{ status: 'rejected', reason: 'empty_file' }] } })
    // One track: its audio, a cover, lyrics and a cue sheet, and two more.
    for (const index of [1, 2, 3, 4, 5, 6]) expect((await upload(`notes ${index}.lrc`, 'lyrics')).status).toBe(200)
    expect(await upload('notes 7.lrc', 'lyrics')).toMatchObject({ status: 413, body: { error: { code: 'import_too_many_files' } } })
    await eventually(async () => expect((await jobsFor(wanted))[0]).toMatchObject({ status: 'failed' }), 10_000)
    expect((await jobsFor(wanted))[0]!.error).toMatch(/over the limit: An import may hold at most 6 files/)
  })

  it('finishes jobs that were in flight when the server restarted, so no session waits forever', async () => {
    const album = await createAlbum({ tracks: [{ title: 'Interrupted', durationMs: 3000 }, { title: 'Stuck Resolving', durationMs: 3000 }, { title: 'Gone Quiet', durationMs: 3000 }] })
    const [interrupted, stuck, quiet] = album.tracks.map((track) => track.recordingId) as [string, string, string]

    // A delivery that was imported just before the restart; its `acquisition.finish` job was lost.
    const tone = await makeTone(fixtures, { path: 'interrupted.flac', durationSec: 3, frequency: 530, tags: { title: 'Interrupted', artist: album.artist.name, album: album.title } })
    mock.settings.delayMs = 120_000
    const response = body(await acquire(fan, interrupted), AcquireResponse, 202)
    const jobId = response.items[0]!.id
    await eventually(async () => expect((await jobsFor(interrupted))[0]?.status).toBe('queued'), 10_000)
    await deliver({ delivery: mock.jobs.get(jobId)!.delivery }, [{ path: tone, name: 'interrupted.flac' }])
    await settle(interrupted)
    expect((await jobsFor(interrupted))[0]).toMatchObject({ status: 'completed', error: null })
    // Put it back as a restart would have left it: imported, but the job still `importing`.
    await db.update(acquisitionJobs).set({ status: 'importing', completedAt: null, idempotencyKey: `recording:${interrupted}` }).where(eq(acquisitionJobs.id, jobId))

    // A session that reloaded holds it preparing; its request joins the open job.
    const phone = await device(fan)
    play(phone, [interrupted], album.albumId)
    await eventually(() => expect(phone.client.getSnapshot().session.current).toMatchObject({ trackId: interrupted }), 5000)
    expect(await jobsFor(interrupted)).toHaveLength(1)

    // A job whose start was lost, and one whose provider went quiet and then failed.
    mock.settings.delayMs = 0
    await db.insert(acquisitionJobs).values({
      id: newId(), providerId, requestedBy: fan.id, recordingId: stuck, recordingIds: [stuck], status: 'resolving',
      idempotencyKey: `recording:${stuck}`, updatedAt: new Date(Date.now() - 10 * 60_000),
    })
    mock.settings.delayMs = 120_000
    body(await acquire(fan, quiet), AcquireResponse, 202)
    await eventually(async () => expect((await jobsFor(quiet))[0]?.status).toBe('queued'), 10_000)
    const [quietJob] = await jobsFor(quiet)
    Object.assign(mock.jobs.get(quietJob!.id)!, { status: 'failed', error: 'disk on fire' })
    mock.settings.delayMs = 0

    await sweepJobs(Date.now() + 2 * 60_000)
    await drainJobs()
    await settle(stuck)
    expect((await jobsFor(interrupted))[0]).toMatchObject({ status: 'completed' })
    expect((await jobsFor(stuck))[0]).toMatchObject({ status: 'completed' })
    expect((await jobsFor(quiet))[0]).toMatchObject({ status: 'failed', error: 'The provider failed: disk on fire' })
    await eventually(() => expect(phone.client.getSnapshot().session.current).toMatchObject({ trackId: interrupted, state: 'ready' }), 10_000)

    // Lost notifications are made up for by the reconciliation in the API process.
    const outcome = await recentOutcome()
    expect(outcome.ready).toEqual(expect.arrayContaining([interrupted, stuck]))
    expect(outcome.failed).toContain(quiet)
    await applyOutcome(outcome)
  })

  it('fetches a whole album in one job', async () => {
    const album = await createAlbum({ title: 'Complete Works', tracks: [{ title: 'Opening', durationMs: 3000 }, { title: 'Closing', durationMs: 4000 }] })
    const ids = album.tracks.map((track) => track.recordingId)
    const response = body(await app.inject({ method: 'POST', url: `/api/v1/albums/${album.albumId}/acquire`, headers: fan.headers }), AcquireResponse, 202)
    expect(response.items).toHaveLength(1)
    expect(response.items[0]).toMatchObject({ albumId: album.albumId, trackId: null, title: `Complete Works — ${album.artist.name}` })
    await settle(ids[0]!)
    const [job] = await jobsFor(ids[0]!)
    expect(job).toMatchObject({ status: 'completed', error: null, recordingIds: ids })
    expect(mock.resolved.at(-1)).toMatchObject({ kind: 'album', album: { title: 'Complete Works', tracks: [{ title: 'Opening' }, { title: 'Closing' }] } })
    expect([...(await trackAvailability(ids)).values()]).toEqual(['server', 'server'])
  })

  it('keeps a delivery out of reviews, imports and the library counts, counts it as cache, and files it under _Fetched', async () => {
    const admin = await signIn({ role: 'admin' })
    const stats = async () => body(await app.inject({ url: '/api/v1/admin/library/stats', headers: admin.headers }), LibraryStats)
    const usage = async () => body(await app.inject({ url: '/api/v1/admin/acquisition/usage', headers: admin.headers }), AcquisitionUsage)
    const before = { stats: await stats(), usage: await usage() }
    const album = await createAlbum({ title: 'Heard Once', tracks: [{ title: 'Sampled', durationMs: 3000 }] })
    const wanted = album.tracks[0]!.recordingId
    expect(body(await acquire(fan, wanted), AcquireResponse, 202).items[0]).toMatchObject({ origin: 'library' })
    await settle(wanted)
    const [job] = await jobsFor(wanted)
    expect(job).toMatchObject({ status: 'completed', origin: 'library' })

    const reviews = body(await app.inject({ url: '/api/v1/admin/reviews?status=open&limit=200', headers: admin.headers }), MatchReviewList)
    expect(reviews.items).toEqual([])
    const listed = body(await app.inject({ url: '/api/v1/imports?limit=200', headers: admin.headers }), ImportList)
    expect(listed.items.map((item) => item.id)).not.toContain(job!.importId)
    expect(listed.items.every((item) => item.kind !== 'acquisition')).toBe(true)
    const deliveries = body(await app.inject({ url: '/api/v1/imports?kind=acquisition&limit=200', headers: admin.headers }), ImportList)
    expect(deliveries.items.map((item) => item.id)).toContain(job!.importId)

    expect(await stats()).toEqual(before.stats)
    const [file] = await db.select().from(mediaFiles).where(eq(mediaFiles.importId, job!.importId!))
    expect(await usage()).toMatchObject({ cachedFiles: before.usage.cachedFiles + 1, cachedBytes: before.usage.cachedBytes + file!.size, limitBytes: 0 })
    expect(file!.relPath).toBe(`_Fetched/${album.artist.name}/Heard Once (2024)/01 Sampled.flac`)
    await access(path.join(rootDir, file!.relPath))
  })

  it('accepts a play while the cache is over its limit, and evicts nothing that was just fetched', async () => {
    await updateAcquisitionPolicy({ storageQuotaBytes: 1 })
    try {
      const album = await createAlbum({ title: 'Over The Limit', tracks: [{ title: 'Still Plays', durationMs: 3000 }] })
      const wanted = album.tracks[0]!.recordingId
      const phone = await device(fan)
      play(phone, [wanted], album.albumId)
      // The client shows its own entry first; the server's answer makes it preparing.
      await eventually(() => expect(phone.client.getSnapshot().session.current).toMatchObject({ trackId: wanted, state: 'preparing' }), 5000)
      await eventually(() => expect(phone.client.getSnapshot().session.current).toMatchObject({ trackId: wanted, state: 'ready' }))
      await settle(wanted)
      expect(await jobsFor(wanted)).toMatchObject([{ status: 'completed', origin: 'play' }])
      expect(await db.select().from(acquisitionJobs).where(eq(acquisitionJobs.status, 'rejected'))).toEqual([])
      // Completing over the limit queued an eviction; the new file is too young to go.
      expect((await trackAvailability([wanted])).get(wanted)).toBe('server')
      // Playing is not adding: the fetched track serves playback and is in nobody's library.
      expect(await db.select().from(likes).where(inArray(likes.entityId, [wanted, album.albumId]))).toEqual([])
    } finally {
      await updateAcquisitionPolicy({ storageQuotaBytes: 0 })
    }
  })

  it('waits out a provider that says it is busy: no miss, and the entry never fails', async () => {
    configureAcquisition({ slotWaitSeconds: 1 })
    try {
      mock.settings.busyTimes = 2
      const album = await createAlbum({ title: 'Busy Signal', tracks: [{ title: 'Second Try', durationMs: 3000 }] })
      const wanted = album.tracks[0]!.recordingId
      const phone = await device(fan)
      const states: string[] = []
      const unsubscribe = phone.client.subscribe(() => {
        const current = phone.client.getSnapshot().session.current
        if (current?.trackId === wanted && current.state !== states.at(-1)) states.push(current.state)
      })
      play(phone, [wanted], album.albumId)
      await eventually(() => expect(states).toContain('preparing'), 5000)
      await eventually(() => expect(states.at(-1)).toBe('ready'), 30_000)
      unsubscribe()
      await settle(wanted)
      expect(mock.settings.busyTimes).toBe(0)
      expect(await jobsFor(wanted)).toMatchObject([{ status: 'completed', error: null }])
      expect(await db.select().from(acquisitionMisses).where(eq(acquisitionMisses.entityId, wanted))).toEqual([])
      expect(states).not.toContain('failed')
    } finally {
      configureAcquisition({ slotWaitSeconds: 5 })
    }
  })

  it('hands a job back to a provider that took it and then failed as rate limited: no miss, no failure counted', async () => {
    configureAcquisition({ slotWaitSeconds: 1 })
    try {
      mock.settings.rateLimitedTimes = 2
      const album = await createAlbum({ title: 'Rate Limited', tracks: [{ title: 'Third Time', durationMs: 3000 }] })
      const wanted = album.tracks[0]!.recordingId
      const phone = await device(fan)
      play(phone, [wanted], album.albumId)
      await eventually(() => expect(phone.client.getSnapshot().session.current).toMatchObject({ trackId: wanted, state: 'ready' }), 30_000)
      await settle(wanted)
      expect(mock.settings.rateLimitedTimes).toBe(0)
      // One job throughout: the provider ran it again rather than the server starting another.
      expect(await jobsFor(wanted)).toMatchObject([{ status: 'completed', error: null }])
      expect(await db.select().from(acquisitionMisses).where(eq(acquisitionMisses.entityId, wanted))).toEqual([])
      const [provider] = await db.execute<{ failing: string[] }>(sql`select failing_recordings as failing from acquisition_providers where id = ${providerId}`)
      expect(provider!.failing).not.toContain(wanted)
    } finally {
      configureAcquisition({ slotWaitSeconds: 5 })
    }
  })

  it('starts the track being played before prefetches and library saves that were asked for earlier', async () => {
    const admin = await signIn({ role: 'admin' })
    const refresh = async () => expect((await app.inject({ method: 'POST', url: `/api/v1/admin/acquisition/providers/${providerId}/test`, headers: admin.headers })).statusCode).toBe(200)
    configureAcquisition({ slotWaitSeconds: 1 })
    mock.settings.maxConcurrent = 1
    await refresh()
    // The one slot must be free. Earlier tests can leave a job the provider holds for minutes
    // (a prefetch for an old queue, taken while the mock was told to be slow); end them.
    for (const left of await db.select({ id: acquisitionJobs.id }).from(acquisitionJobs).where(isNull(acquisitionJobs.completedAt))) {
      await finishJob(left.id, { status: 'failed', error: 'Ended by the test' })
    }
    try {
      const album = await createAlbum({ title: 'One At A Time', tracks: ['Holder', 'Saved', 'Ahead', 'Playing'].map((title) => ({ title, durationMs: 2000 })) })
      const [holder, saved, ahead, playing] = album.tracks.map((track) => track.recordingId) as [string, string, string, string]
      mock.settings.delayMs = 1500
      body(await app.inject({ method: 'POST', url: `/api/v1/tracks/${holder}/acquire`, headers: fan.headers }), AcquireResponse, 202)
      await eventually(async () => expect((await jobsFor(holder))[0]).toMatchObject({ status: 'queued' }), 10_000)

      body(await app.inject({ method: 'POST', url: `/api/v1/tracks/${saved}/acquire?origin=library`, headers: fan.headers }), AcquireResponse, 202)
      await requestRecording({ userId: fan.id, recordingId: ahead, albumId: album.albumId, origin: 'prefetch' })
      await requestRecording({ userId: fan.id, recordingId: playing, albumId: album.albumId, origin: 'play' })
      // All three have chosen the provider and wait for its one slot.
      await eventually(async () => {
        for (const id of [saved, ahead, playing]) expect((await jobsFor(id))[0]).toMatchObject({ status: 'resolving', offer: expect.anything() })
      }, 10_000)
      expect((await jobsFor(holder))[0]!.completedAt).toBeNull()

      for (const id of [holder, saved, ahead, playing]) await settle(id)
      const order = (await Promise.all([holder, playing, ahead, saved].map(async (id) => (await jobsFor(id))[0]!.id)))
      expect([...mock.jobs.keys()].filter((id) => order.includes(id))).toEqual(order)
      expect((await Promise.all([saved, ahead, playing].map(async (id) => (await jobsFor(id))[0]!.origin)))).toEqual(['library', 'prefetch', 'play'])
    } finally {
      configureAcquisition({ slotWaitSeconds: 5 })
      mock.settings.maxConcurrent = 4
      await refresh()
    }
  }, 60_000)

  it('moves a job up when the track it fetches is played', async () => {
    const album = await createAlbum({ title: 'Promoted', tracks: [{ title: 'Saved First', durationMs: 2000 }] })
    const wanted = album.tracks[0]!.recordingId
    mock.settings.delayMs = 500
    body(await app.inject({ method: 'POST', url: `/api/v1/tracks/${wanted}/acquire?origin=library`, headers: fan.headers }), AcquireResponse, 202)
    await requestRecording({ userId: fan.id, recordingId: wanted, albumId: album.albumId, origin: 'play' })
    await settle(wanted)
    expect(await jobsFor(wanted)).toMatchObject([{ status: 'completed', origin: 'play' }])
  })

  it('caps how many fetches a member may have running, but not an admin', async () => {
    // Two jobs at most: each import holds one of the test database's four connections.
    configureAcquisition({ memberJobLimit: 1 })
    mock.settings.delayMs = 1000
    try {
      const album = await createAlbum({ title: 'Many At Once', tracks: ['One', 'Two'].map((title) => ({ title, durationMs: 2000 })) })
      const [first, second] = album.tracks.map((track) => track.recordingId) as [string, string]
      const member = await signIn({ canAcquire: true })
      body(await acquire(member, first), AcquireResponse, 202)
      expect(errorCode(await acquire(member, second), 429)).toBe('acquire_limit_reached')
      // Joining a job already running costs nothing.
      expect(body(await acquire(member, first), AcquireResponse, 202).items).toHaveLength(1)
      const admin = await signIn({ role: 'admin' })
      body(await acquire(admin, second), AcquireResponse, 202)
      for (const id of [first, second]) await settle(id)
      expect((await jobsFor(second))[0]).toMatchObject({ status: 'completed', requestedBy: admin.id })
    } finally {
      configureAcquisition({ memberJobLimit: 100 })
    }
  })

  it("does not show a member who may not fetch anything about other users' jobs", async () => {
    const album = await createAlbum({ title: 'Private Fetch', tracks: [{ title: 'Mine', durationMs: 2000 }] })
    const wanted = album.tracks[0]!.recordingId
    mock.settings.delayMs = 1000
    body(await acquire(fan, wanted), AcquireResponse, 202)
    const member = await signIn()
    const refused = await acquire(member, wanted)
    expect(errorCode(refused, 403)).toBe('acquire_not_allowed')
    expect(refused.body).not.toContain(fan.username)
    await settle(wanted)
  })

  it('marks a provider that fails different tracks as failing instead of graying each track, until it delivers again', async () => {
    const admin = await signIn({ role: 'admin' })
    const health = async () => body(await app.inject({ url: '/api/v1/admin/acquisition/providers', headers: admin.headers }), AcquisitionProviderList).items.find((item) => item.id === providerId)!
    const missesOf = (ids: string[]) => db.select().from(acquisitionMisses).where(and(eq(acquisitionMisses.providerId, providerId), inArray(acquisitionMisses.entityId, ids)))
    const album = await createAlbum({ title: 'Signed Out', tracks: ['One', 'Two', 'Three', 'Four'].map((title) => ({ title, durationMs: 3000 })) })
    const ids = album.tracks.map((track) => track.recordingId)
    mock.settings.fail = true
    // Two tracks fail: each could just be missing at the source, so each gets a miss.
    for (const id of ids.slice(0, 2)) {
      body(await acquire(fan, id), AcquireResponse, 202)
      await settle(id)
    }
    expect(await missesOf(ids)).toHaveLength(2)
    const before = await health()
    expect(before.failingSince).toBeNull()
    expect(before.lastError).toBe('The provider failed: The mock provider was told to fail')

    // A third different track: the provider is what fails. The misses go, the tracks stay playable.
    body(await acquire(fan, ids[2]!), AcquireResponse, 202)
    await settle(ids[2]!)
    expect(await missesOf(ids)).toEqual([])
    expect((await trackAvailability(ids)).get(ids[0]!)).toBe('on_demand')
    const failing = await health()
    expect(failing.failingSince).not.toBeNull()
    expect(failing.lastError).toBe('The provider failed: The mock provider was told to fail')

    // Once it delivers again, it is healthy.
    mock.settings.fail = false
    body(await acquire(fan, ids[3]!), AcquireResponse, 202)
    await settle(ids[3]!)
    expect(await health()).toMatchObject({ failingSince: null, lastError: null })
    expect((await jobsFor(ids[3]!))[0]?.status).toBe('completed')
  })
})
