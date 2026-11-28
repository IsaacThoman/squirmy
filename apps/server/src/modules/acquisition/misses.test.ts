import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createMockProvider, type MockProvider } from '@squirmy/adapter-mock'
import { AcquisitionProviderList, ClearProviderMissesResponse } from '@squirmy/contracts'
import { eq, sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { buildApp } from '../../app.js'
import { db } from '../../database/client.js'
import { acquisitionJobs, acquisitionMisses, acquisitionProviders } from '../../database/schema.js'
import { jobs, startJobs, stopJobs } from '../../jobs/index.js'
import { newId } from '../../lib/ids.js'
import { body, errorCode, signIn } from '../../test/api.js'
import { listenRealtime } from '../../test/realtime.js'
import { useTestDatabase } from '../../test/database.js'
import { createAlbum, createUser } from '../../test/factories.js'
import { saysBusy } from './client.js'
import { onDemandRecordings } from './coverage.js'
import { acquisitionModule } from './index.js'
import { startJob } from './jobs.js'
import { checkProviders, createProvider, invalidateProviders, updateProvider } from './providers.js'
import { recordMisses, resetResolveQueue, runResolveJob } from './resolve.js'

type Handler = (request: IncomingMessage, response: ServerResponse) => void

describe('provider misses', () => {
  useTestDatabase()
  const secret = 'misses-provider-secret'
  let app: FastifyInstance
  let admin: Awaited<ReturnType<typeof signIn>>
  let mock: MockProvider
  let url = ''

  beforeAll(async () => {
    app = await buildApp()
    admin = await signIn({ role: 'admin' })
    await acquisitionModule.jobs!(jobs)
    // Jobs are queued, never run: the tests look at what was queued.
    await startJobs({ work: false })
    mock = createMockProvider({ secret, version: '1.0.0' })
    url = await mock.listen()
  })
  beforeEach(async () => {
    await db.delete(acquisitionProviders)
    invalidateProviders()
    resetResolveQueue()
    Object.assign(mock.settings, { version: '1.0.0', coverage: 'assume_available' })
  })
  afterAll(async () => {
    await stopJobs()
    await mock.close()
    await app.close()
  })

  const provider = async () => (await createProvider({ name: 'Mock', baseUrl: url, secret, enabled: true, priority: 0 })).id
  const tracks = async (count: number) => (await createAlbum({ tracks: Array.from({ length: count }, (_, index) => ({ title: `Song ${index + 1}` })) })).tracks.map((track) => track.recordingId)
  const listed = async (providerId: string) =>
    body(await app.inject({ url: '/api/v1/admin/acquisition/providers', headers: admin.headers }), AcquisitionProviderList).items.find((item) => item.id === providerId)!

  it('stops counting misses once the provider reports another version, and keeps the rows', async () => {
    const providerId = await provider()
    const [one, two] = await tracks(2) as [string, string]
    await recordMisses(db, providerId, 'recording', [one, two], 'The buggy version found nothing')
    expect(await onDemandRecordings([one, two])).toEqual(new Set())
    expect((await listed(providerId)).unavailableTracks).toBe(2)

    // The same version answering again changes nothing.
    await checkProviders()
    expect(await onDemandRecordings([one, two])).toEqual(new Set())

    const events = await listenRealtime()
    mock.settings.version = '1.0.1'
    await checkProviders()
    await events.stop()
    expect(await onDemandRecordings([one, two])).toEqual(new Set([one, two]))
    expect(await listed(providerId)).toMatchObject({ unavailableTracks: 0, capabilities: { version: '1.0.1' } })
    expect(events.availability.get(one)).toBe('on_demand')
    const history = await db.select().from(acquisitionMisses).where(eq(acquisitionMisses.providerId, providerId))
    expect(history).toHaveLength(2)
    expect(history[0]!.providerIdentity).toMatch(/^1\.0\.0#[0-9a-f]{16}$/)

    // What the new version misses counts again.
    await recordMisses(db, providerId, 'recording', [one], 'Not at the source')
    expect(await onDemandRecordings([one, two])).toEqual(new Set([two]))
    const [again] = await db.select().from(acquisitionMisses).where(eq(acquisitionMisses.entityId, one))
    expect(again!.providerIdentity).toMatch(/^1\.0\.1#/)
  })

  it('treats other capabilities as another build when the provider declares no version', async () => {
    mock.settings.version = undefined
    const providerId = await provider()
    const [one] = await tracks(1) as [string]
    await recordMisses(db, providerId, 'recording', [one], 'Not found')
    await checkProviders()
    expect(await onDemandRecordings([one])).toEqual(new Set())
    mock.settings.maxConcurrent = 6
    try {
      await checkProviders()
      expect(await onDemandRecordings([one])).toEqual(new Set([one]))
    } finally {
      mock.settings.maxConcurrent = 4
    }
  })

  describe('the five-minute check', () => {
    let server: Server
    let checkedUrl = ''
    /** The status `capabilities` answers with; at 200 it answers as a provider would. */
    let status = 200
    beforeAll(async () => {
      server = createServer((_request, response) => {
        response.writeHead(status, { 'content-type': 'application/json', ...(status === 429 ? { 'retry-after': '7' } : {}) })
        response.end(JSON.stringify(status === 200 ? { protocol: 1, name: 'Checked', coverage: 'assume_available', kinds: ['recording'], formats: ['flac'], maxConcurrent: 1, version: '1.0.0' } : { error: 'Unavailable' }))
      })
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
      checkedUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    })
    beforeEach(() => { status = 200 })
    afterAll(async () => {
      server.closeAllConnections()
      await new Promise((resolve) => server.close(resolve))
    })

    const row = async (providerId: string) => (await db.select().from(acquisitionProviders).where(eq(acquisitionProviders.id, providerId)))[0]!
    const set = (providerId: string, values: Partial<typeof acquisitionProviders.$inferInsert>) =>
      db.update(acquisitionProviders).set(values).where(eq(acquisitionProviders.id, providerId))
    const tenMinutesAgo = () => new Date(Date.now() - 10 * 60_000)
    const justNow = () => expect.toSatisfy((date: Date | null) => date !== null && Date.now() - date.getTime() < 60_000)

    it('counts an answer as the provider answering, and keeps a failing provider’s error', async () => {
      const providerId = await provider()
      await set(providerId, { lastOkAt: tenMinutesAgo(), lastError: 'Resolve timed out' })
      await checkProviders()
      expect(await row(providerId)).toMatchObject({ lastOkAt: justNow(), lastError: null })

      // The error is why its fetches fail; answering `capabilities` does not end the outage.
      const failingSince = new Date(Date.now() - 60_000)
      await set(providerId, { lastOkAt: tenMinutesAgo(), lastError: 'Signed out', failingSince, failingRecordings: await tracks(3) })
      await checkProviders()
      expect(await row(providerId)).toMatchObject({ lastOkAt: justNow(), lastError: 'Signed out', failingSince })
      expect((await listed(providerId)).failingSince).toBe(failingSince.toISOString())
    })

    it('keeps a failed check as the last error, without counting it toward failing', async () => {
      const providerId = (await createProvider({ name: 'Checked', baseUrl: checkedUrl, secret, enabled: true, priority: 0 })).id
      const lastOkAt = tenMinutesAgo()
      await set(providerId, { lastOkAt })
      expect(await row(providerId)).toMatchObject({ lastError: null, identity: expect.stringMatching(/^1\.0\.0#/) })

      status = 503
      await checkProviders()
      expect(await row(providerId)).toMatchObject({ lastOkAt, lastError: expect.any(String), failingSince: null, failingRecordings: [] })

      // A streak short of failing is neither extended nor restarted by checks.
      const failingSince = new Date(Date.now() - 60_000)
      const streak = await tracks(2)
      await set(providerId, { failingSince, failingRecordings: streak })
      for (let check = 0; check < 3; check += 1) await checkProviders()
      expect(await row(providerId)).toMatchObject({ lastOkAt, failingSince, failingRecordings: streak })
      expect((await listed(providerId)).failingSince).toBeNull()

      // Rate limited is not a fault, as with a resolve.
      await set(providerId, { lastError: null })
      status = 429
      await checkProviders()
      expect(await row(providerId)).toMatchObject({ lastOkAt, lastError: null })
    })
  })

  it('asks again for what a provider missed once it is re-enabled or given a new address, ending its failing streak', async () => {
    const providerId = await provider()
    const [one, two, three] = await tracks(3) as [string, string, string]
    await recordMisses(db, providerId, 'recording', [one], 'Not found')
    await db.update(acquisitionProviders).set({ failingSince: new Date(), failingRecordings: [one, two, three], lastError: 'Signed out' })
      .where(eq(acquisitionProviders.id, providerId))

    // Renaming it is not a change to the provider.
    expect(await updateProvider(providerId, { name: 'Renamed' })).toMatchObject({ unavailableTracks: 1 })
    await updateProvider(providerId, { enabled: false })
    expect(await updateProvider(providerId, { enabled: true })).toMatchObject({ unavailableTracks: 0, failingSince: null })
    expect(await onDemandRecordings([one])).toEqual(new Set([one]))

    await recordMisses(db, providerId, 'recording', [two], 'Not found')
    expect(await updateProvider(providerId, { baseUrl: `${url}/` })).toMatchObject({ unavailableTracks: 0, lastError: null })
    expect(await onDemandRecordings([two])).toEqual(new Set([two]))
  })

  it('retries a provider’s unavailable tracks from the admin API, for admins only', async () => {
    const providerId = await provider()
    const ids = await tracks(3)
    await recordMisses(db, providerId, 'recording', ids, 'Not found')
    expect((await listed(providerId)).unavailableTracks).toBe(3)

    const clear = (headers: Record<string, string>) => app.inject({ method: 'POST', url: `/api/v1/admin/acquisition/providers/${providerId}/clear-misses`, headers })
    const member = await signIn()
    expect(errorCode(await clear(member.headers), 403)).toBe('forbidden')
    expect(errorCode(await app.inject({ method: 'POST', url: `/api/v1/admin/acquisition/providers/${newId()}/clear-misses`, headers: admin.headers }), 404)).toBe('provider_not_found')

    const events = await listenRealtime()
    const cleared = body(await clear(admin.headers), ClearProviderMissesResponse)
    await events.stop()
    expect(cleared).toMatchObject({ cleared: 3, provider: { id: providerId, unavailableTracks: 0 } })
    expect(await onDemandRecordings(ids)).toEqual(new Set(ids))
    expect(events.availability.get(ids[0]!)).toBe('on_demand')
    expect(await db.$count(acquisitionMisses, eq(acquisitionMisses.providerId, providerId))).toBe(3)
    expect(body(await clear(admin.headers), ClearProviderMissesResponse).cleared).toBe(0)
  })

  describe('a provider that is rate limited', () => {
    let server: Server
    let rateLimitedUrl = ''
    let handle: Handler = () => {}
    beforeAll(async () => {
      server = createServer((request, response) => handle(request, response))
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
      rateLimitedUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    })
    afterAll(async () => {
      server.closeAllConnections()
      await new Promise((resolve) => server.close(resolve))
    })

    /** Answers `capabilities`; everything else is refused with 429 and `Retry-After: 7`. */
    const rateLimited = async (coverage: 'must_resolve' | 'assume_available', onResolve?: () => void) => {
      handle = (request, response) => {
        if (request.url === '/capabilities') {
          response.writeHead(200, { 'content-type': 'application/json' })
          response.end(JSON.stringify({ protocol: 1, name: 'Limited', coverage, kinds: ['recording'], formats: ['flac'], maxConcurrent: 2 }))
          return
        }
        if (request.url === '/resolve') onResolve?.()
        response.writeHead(429, { 'content-type': 'application/json', 'retry-after': '7' })
        response.end(JSON.stringify({ error: 'Too many requests' }))
      }
      return (await createProvider({ name: 'Limited', baseUrl: rateLimitedUrl, secret, enabled: true, priority: 0 })).id
    }
    const queued = (name: string) => db.execute<{ data: Record<string, unknown>; startAfter: Date }>(sql`
      select data, start_after as "startAfter" from pgboss.job where name = ${name} order by created_on`)
    const health = async (providerId: string) => (await db.select().from(acquisitionProviders).where(eq(acquisitionProviders.id, providerId)))[0]!

    it('asks again soon about a resolve it refused, with no miss and no error', async () => {
      const providerId = await rateLimited('must_resolve')
      const [one] = await tracks(1) as [string]
      await runResolveJob({ providerId, recordingIds: [one] })
      expect(await db.$count(acquisitionMisses, eq(acquisitionMisses.providerId, providerId))).toBe(0)
      expect((await health(providerId)).lastError).toBeNull()
      const retry = (await queued('acquisition.resolve')).find((job) => (job.data.recordingIds as string[]).includes(one))
      expect(retry?.data).toMatchObject({ providerId, attempt: 1 })
      // Retry-After (7 s) is longer than the first backoff (5 s).
      expect(new Date(retry!.startAfter).getTime() - Date.now()).toBeGreaterThan(5_000)
    })

    it('backs off subsequent optimistic batches during Retry-After without graying out tracks', async () => {
      let requests = 0
      const providerId = await rateLimited('assume_available', () => { requests++ })
      const [one, two] = await tracks(2) as [string, string]
      await runResolveJob({ providerId, recordingIds: [one] })
      await runResolveJob({ providerId, recordingIds: [two] })
      expect(requests).toBe(1)
      expect(await db.$count(acquisitionMisses, eq(acquisitionMisses.providerId, providerId))).toBe(0)
      expect((await health(providerId)).lastError).toBeNull()
      const retries = (await queued('acquisition.resolve')).filter((job) => job.data.providerId === providerId)
      expect(retries).toHaveLength(2)
      expect(retries.every((job) => new Date(job.startAfter).getTime() - Date.now() > 5000)).toBe(true)
    })

    it('waits out a job it refused, at resolve or at acquire, without a miss or a failure', async () => {
      const providerId = await rateLimited('assume_available')
      const user = await createUser({ canAcquire: true })
      const [one, two] = await tracks(2) as [string, string]
      const job = async (recordingId: string, offer: Record<string, unknown> | null) => {
        const id = newId()
        await db.insert(acquisitionJobs).values({ id, providerId, requestedBy: user.id, recordingId, recordingIds: [recordingId], idempotencyKey: `recording:${recordingId}`, offer })
        return id
      }
      // No offer yet: the resolve is refused. With one: the acquire is.
      const resolving = await job(one, null)
      const acquiring = await job(two, { offerId: 'flac:1', format: 'flac', lossless: true })
      for (const id of [resolving, acquiring]) await startJob(id)

      for (const id of [resolving, acquiring]) {
        const [row] = await db.select().from(acquisitionJobs).where(eq(acquisitionJobs.id, id))
        expect(row).toMatchObject({ status: 'resolving', completedAt: null, uploadTokenHash: null })
        expect((await queued('acquisition.start')).some((queuedJob) => queuedJob.data.jobId === id && queuedJob.data.attempt === 1)).toBe(true)
      }
      expect(await db.$count(acquisitionMisses, eq(acquisitionMisses.providerId, providerId))).toBe(0)
      expect(await health(providerId)).toMatchObject({ failingSince: null, failingRecordings: [], lastError: null })
    })
  })

  it('reads a refusal as busy by its reason or its wording, and nothing else', () => {
    expect(saysBusy({ reason: 'busy' })).toBe(true)
    expect(saysBusy({ error: 'Provider is busy' })).toBe(true)
    expect(saysBusy({ error: 'Rate limited by the source; try again shortly' })).toBe(true)
    expect(saysBusy({ error: 'HTTP 429: Too Many Requests' })).toBe(true)
    expect(saysBusy({ error: 'rate-limit exceeded' })).toBe(true)
    expect(saysBusy({ error: 'Not found at the source' })).toBe(false)
    expect(saysBusy({ error: 'The provider is busy elsewhere' })).toBe(false)
    expect(saysBusy({ reason: 'not_found', error: null })).toBe(false)
  })
})
