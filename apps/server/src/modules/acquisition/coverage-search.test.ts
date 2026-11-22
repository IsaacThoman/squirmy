import { AcquisitionProvider, SearchResults } from '@squirmy/contracts'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from '../../app.js'
import { db } from '../../database/client.js'
import { acquisitionProviders } from '../../database/schema.js'
import { encrypt } from '../../lib/crypto.js'
import { newId } from '../../lib/ids.js'
import { body, signIn } from '../../test/api.js'
import { useTestDatabase } from '../../test/database.js'
import { useHttpFixtures } from '../../test/http.js'
import { invalidateProviders } from './providers.js'
import { resetResolveQueue } from './resolve.js'

/**
 * A provider that fetches nearly anything but declares `must_resolve`, overridden by the
 * admin: a search nobody made before is playable on first sight. Catalog answers are
 * recorded; the provider is a row only, since nothing here calls it.
 */
describe('an assume_available override and catalog search', () => {
  useTestDatabase()
  useHttpFixtures('deezer', 'musicbrainz')
  let app: FastifyInstance
  let fan: Awaited<ReturnType<typeof signIn>>
  let admin: Awaited<ReturnType<typeof signIn>>
  let providerId = ''

  beforeAll(async () => {
    app = await buildApp()
    fan = await signIn({ canAcquire: true })
    admin = await signIn({ role: 'admin' })
    providerId = newId()
    await db.insert(acquisitionProviders).values({
      id: providerId, name: 'Fetches anything', baseUrl: 'http://provider.invalid', secretEncrypted: encrypt('acquisition-provider-secret', 'a-secret-value'),
      coverage: 'must_resolve', lastOkAt: new Date(),
      capabilities: { protocol: 1, name: 'Fetches anything', coverage: 'must_resolve', kinds: ['recording'], formats: ['flac'], maxConcurrent: 2 },
    })
    invalidateProviders()
  })
  afterAll(async () => {
    resetResolveQueue()
    await app.close()
  })

  it('shows every track and every album without a track list on demand on the first search', async () => {
    const patched = await app.inject({ method: 'PATCH', url: `/api/v1/admin/acquisition/providers/${providerId}`, headers: admin.headers, payload: { coverage: 'assume_available' } })
    expect(body(patched, AcquisitionProvider)).toMatchObject({ coverage: 'assume_available', capabilities: { coverage: 'must_resolve' } })

    const results = body(await app.inject({ url: `/api/v1/search/catalog?q=${encodeURIComponent('Radiohead OK Computer')}&limit=5`, headers: fan.headers }), SearchResults)
    expect(results.tracks.length).toBeGreaterThan(0)
    expect(results.tracks.map((track) => track.availability)).toEqual(results.tracks.map(() => 'on_demand'))
    expect(results.albums.length).toBeGreaterThan(0)
    for (const album of results.albums) {
      expect(album.trackCount).toBe(0)
      expect(album.availability).toBe('on_demand')
    }
    resetResolveQueue()
  })
})
