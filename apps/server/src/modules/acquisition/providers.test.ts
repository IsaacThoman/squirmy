import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createMockProvider, type MockProvider } from '@squirmy/adapter-mock'
import {
  AcquisitionJobList, AcquisitionPolicy, AcquisitionProvider, AcquisitionProviderList, Ok,
} from '@squirmy/contracts'
import { eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from '../../app.js'
import { db } from '../../database/client.js'
import { acquisitionJobs, acquisitionProviders } from '../../database/schema.js'
import { newId } from '../../lib/ids.js'
import { body, errorCode, signIn } from '../../test/api.js'
import { useTestDatabase } from '../../test/database.js'
import { createAlbum } from '../../test/factories.js'
import { configureProviderTimeouts } from './client.js'

type Handler = (request: IncomingMessage, response: ServerResponse) => void

/** A provider that answers however the test says. */
async function rogueProvider(): Promise<{ url: string; handle: (handler: Handler) => void; close: () => Promise<void> }> {
  let current: Handler = (_request, response) => response.end()
  const server: Server = createServer((request, response) => current(request, response))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    handle: (handler) => { current = handler },
    close: async () => {
      server.closeAllConnections()
      await new Promise((resolve) => server.close(resolve))
    },
  }
}

const json = (status: number, payload: unknown): Handler => (_request, response) => {
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(JSON.stringify(payload))
}

describe('acquisition providers (admin)', () => {
  useTestDatabase()
  let app: FastifyInstance
  let admin: Awaited<ReturnType<typeof signIn>>
  let mock: MockProvider
  let mockUrl = ''
  let rogue: Awaited<ReturnType<typeof rogueProvider>>

  beforeAll(async () => {
    app = await buildApp()
    admin = await signIn({ role: 'admin' })
    mock = createMockProvider({ secret: 'mock-secret-123' })
    mockUrl = await mock.listen()
    rogue = await rogueProvider()
  })
  afterEach(() => configureProviderTimeouts({ capabilities: 10_000 }))
  afterAll(async () => {
    await mock.close()
    await rogue.close()
    await app.close()
  })

  const create = (payload: Record<string, unknown>) =>
    app.inject({ method: 'POST', url: '/api/v1/admin/acquisition/providers', headers: admin.headers, payload })
  const patch = (id: string, payload: Record<string, unknown>) =>
    app.inject({ method: 'PATCH', url: `/api/v1/admin/acquisition/providers/${id}`, headers: admin.headers, payload })
  const test = (id: string) => app.inject({ method: 'POST', url: `/api/v1/admin/acquisition/providers/${id}/test`, headers: admin.headers })

  it('creates, lists, updates and deletes a provider, testing it on create, and never returns the secret', async () => {
    const created = body(await create({ name: 'Mock', baseUrl: mockUrl, secret: 'mock-secret-123', priority: 5 }), AcquisitionProvider, 201)
    expect(created).toMatchObject({
      name: 'Mock', baseUrl: mockUrl, enabled: true, priority: 5, coverage: 'assume_available', lastError: null,
      capabilities: { protocol: 1, name: 'Mock tones', coverage: 'assume_available', kinds: ['recording', 'album'], maxConcurrent: 4 },
    })
    expect(created.lastOkAt).not.toBeNull()
    const [row] = await db.select().from(acquisitionProviders).where(eq(acquisitionProviders.id, created.id))
    expect(row!.secretEncrypted).not.toContain('mock-secret-123')

    const list = await app.inject({ method: 'GET', url: '/api/v1/admin/acquisition/providers', headers: admin.headers })
    expect(list.body).not.toContain('mock-secret-123')
    expect(body(list, AcquisitionProviderList).items.map((provider) => provider.id)).toContain(created.id)

    // A PATCH with one key changes that key only: the request schema has no defaults.
    const disabled = body(await patch(created.id, { enabled: false }), AcquisitionProvider)
    expect(disabled).toMatchObject({ enabled: false, priority: 5, name: 'Mock' })
    const renamed = body(await patch(created.id, { name: 'Tones' }), AcquisitionProvider)
    expect(renamed).toMatchObject({ enabled: false, priority: 5, name: 'Tones' })

    body(await app.inject({ method: 'DELETE', url: `/api/v1/admin/acquisition/providers/${created.id}`, headers: admin.headers }), Ok)
    expect(await db.select().from(acquisitionProviders).where(eq(acquisitionProviders.id, created.id))).toEqual([])
  })

  it('keeps a provider whose test fails and records why', async () => {
    const wrongSecret = body(await create({ name: 'Wrong secret', baseUrl: mockUrl, secret: 'not-the-secret' }), AcquisitionProvider, 201)
    expect(wrongSecret).toMatchObject({ capabilities: null, lastOkAt: null, lastError: 'The provider refused the shared secret' })

    const fixed = body(await patch(wrongSecret.id, { secret: 'mock-secret-123' }), AcquisitionProvider)
    expect(fixed).toMatchObject({ lastError: null, capabilities: { name: 'Mock tones' } })
  })

  it('reports bad answers, redirects to other hosts and timeouts without failing the request', async () => {
    const provider = body(await create({ name: 'Rogue', baseUrl: rogue.url, secret: 'rogue-secret' }), AcquisitionProvider, 201)
    const cases: [Handler, RegExp][] = [
      [(_request, response) => response.end('not json'), /did not answer with JSON/],
      [json(200, { protocol: 2, name: 'Future', coverage: 'must_resolve', kinds: ['recording'] }), /unexpected shape/],
      [json(200, { protocol: 1, name: 'No kinds', coverage: 'must_resolve', kinds: [] }), /unexpected shape/],
      [json(500, { error: 'boom' }), /HTTP 500/],
      [(_request, response) => { response.writeHead(302, { location: 'http://example.com/capabilities' }); response.end() }, /redirected to another host/],
      [(_request, response) => { response.writeHead(200, { 'content-type': 'application/json' }); response.end('x'.repeat(5 * 1024 * 1024)) }, /larger than/],
      [() => {}, /did not answer within 0.2 seconds/],
    ]
    configureProviderTimeouts({ capabilities: 200 })
    for (const [handler, message] of cases) {
      rogue.handle(handler)
      const tested = body(await test(provider.id), AcquisitionProvider)
      expect(tested.lastError, String(message)).toMatch(message)
      expect(tested.capabilities).toBeNull()
    }

    // A redirect within the provider's own origin is followed, with the secret.
    rogue.handle((request, response) => {
      if (request.url === '/capabilities') {
        response.writeHead(307, { location: '/v1/capabilities' })
        return response.end()
      }
      expect(request.headers.authorization).toBe('Bearer rogue-secret')
      json(200, { protocol: 1, name: 'Moved', coverage: 'must_resolve', kinds: ['recording'] })(request, response)
    })
    expect(body(await test(provider.id), AcquisitionProvider)).toMatchObject({ lastError: null, coverage: 'must_resolve', capabilities: { name: 'Moved', maxConcurrent: 2 } })
  })

  it('reads and patches the policy without resetting other keys', async () => {
    const policy = body(await app.inject({ method: 'GET', url: '/api/v1/admin/acquisition/policy', headers: admin.headers }), AcquisitionPolicy)
    expect(policy).toEqual({ preferLossless: true, maxFileBytes: 500 * 1024 ** 2, storageQuotaBytes: 0, timeoutSeconds: 900, targetRootId: null, deliveryBaseUrl: null })
    const update = (payload: Record<string, unknown>) => app.inject({ method: 'PATCH', url: '/api/v1/admin/acquisition/policy', headers: admin.headers, payload })
    body(await update({ timeoutSeconds: 120 }), AcquisitionPolicy)
    expect(body(await update({ deliveryBaseUrl: 'http://squirmy:4747' }), AcquisitionPolicy)).toMatchObject({ timeoutSeconds: 120, deliveryBaseUrl: 'http://squirmy:4747', preferLossless: true })
    expect(errorCode(await update({ timeoutSeconds: 5 }), 400)).toBe('invalid_request')
    expect(errorCode(await update({ targetRootId: newId() }), 400)).toBe('target_root_not_managed')
  })

  it('lists jobs newest first, a page at a time', async () => {
    const provider = body(await create({ name: 'Mock for jobs', baseUrl: mockUrl, secret: 'mock-secret-123' }), AcquisitionProvider, 201)
    const album = await createAlbum({ tracks: [{ title: 'Alpha' }, { title: 'Beta' }, { title: 'Gamma' }] })
    for (const [index, track] of album.tracks.entries()) {
      await db.insert(acquisitionJobs).values({
        id: newId(), providerId: provider.id, requestedBy: admin.id, recordingId: track.recordingId, recordingIds: [track.recordingId],
        status: index === 0 ? 'failed' : 'completed', idempotencyKey: `test:${index}`, error: index === 0 ? 'Nope' : null,
      })
    }
    const first = body(await app.inject({ method: 'GET', url: '/api/v1/admin/acquisition/jobs?limit=2', headers: admin.headers }), AcquisitionJobList)
    expect(first.items.map((job) => job.title)).toEqual([`Gamma — ${album.artist.name}`, `Beta — ${album.artist.name}`])
    expect(first.items[0]).toMatchObject({ providerName: 'Mock for jobs', requestedBy: admin.username, status: 'completed', trackId: album.tracks[2]!.recordingId })
    const second = body(await app.inject({ method: 'GET', url: `/api/v1/admin/acquisition/jobs?limit=2&cursor=${first.nextCursor}`, headers: admin.headers }), AcquisitionJobList)
    expect(second).toMatchObject({ nextCursor: null, items: [{ title: `Alpha — ${album.artist.name}`, status: 'failed', error: 'Nope' }] })
    const failed = body(await app.inject({ method: 'GET', url: '/api/v1/admin/acquisition/jobs?status=failed', headers: admin.headers }), AcquisitionJobList)
    expect(failed.items).toHaveLength(1)
  })

  it('is for admins only', async () => {
    const member = await signIn()
    for (const [method, url] of [['GET', 'providers'], ['POST', 'providers'], ['GET', 'policy'], ['PATCH', 'policy'], ['GET', 'jobs']] as const) {
      expect(errorCode(await app.inject({ method, url: `/api/v1/admin/acquisition/${url}`, headers: member.headers, payload: {} }), 403)).toBe('forbidden')
    }
  })
})
