import { AlbumDetail, ArtistDetail } from '@squirmy/contracts'
import { eq, sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildApp } from '../app.js'
import { resetConfig } from '../config.js'
import { db, getSql } from '../database/client.js'
import { albums, artists } from '../database/schema.js'
import { remoteImage } from '../modules/artwork/store.js'
import { upsertDiscography } from '../modules/enrichment/artist.js'
import { albumStub, artistStub } from '../modules/enrichment/test-stubs.js'
import type { MbReleaseGroupSummary } from '../modules/metadata/musicbrainz.js'
import { cleanupStubs, stubMaxAgeDays } from '../modules/search/cleanup.js'
import { startRealtime } from '../realtime/index.js'
import { body, signIn } from '../test/api.js'
import { useTestDatabase } from '../test/database.js'
import { createAlbum, createArtist } from '../test/factories.js'
import { clearReadCache, readCacheStats } from './read-cache.js'

/**
 * Writes made outside a request handler, often in the worker process, must drop the API
 * process's cached reads. Each test checks both halves: this process's entries go, and
 * the NOTIFY that reaches the API process when the worker made the change carries the keys.
 */
describe('cached reads after background writes', () => {
  useTestDatabase()
  let app: FastifyInstance
  let user: Awaited<ReturnType<typeof signIn>>

  beforeAll(async () => {
    process.env.SQUIRMY_READ_CACHE_MB = '16'
    resetConfig()
    app = await buildApp()
    await startRealtime(app)
    user = await signIn()
  })
  afterAll(async () => {
    await app.close()
    delete process.env.SQUIRMY_READ_CACHE_MB
    resetConfig()
  })
  beforeEach(() => clearReadCache())
  afterEach(() => vi.unstubAllGlobals())

  const get = (url: string) => app.inject({ url: `/api/v1${url}`, headers: user.headers })
  /** The query keys invalidated over NOTIFY while `run` runs. */
  const notifiedKeys = async (run: () => Promise<unknown>) => {
    const keys: unknown[] = []
    const listener = await getSql().listen('squirmy_events', (payload) => {
      const message = JSON.parse(payload) as { kind: string; keys?: unknown[] }
      if (message.kind === 'invalidate') keys.push(...message.keys!)
    })
    try {
      await run()
      await new Promise((resolve) => setTimeout(resolve, 100))
    } finally {
      await listener.unlisten()
    }
    return keys
  }

  it('drops pages that show a cover once its source says it does not exist', async () => {
    vi.stubGlobal('fetch', async () => new Response('nope', { status: 404 }))
    const album = await createAlbum({ title: 'Coverless', owned: true })
    const artist = await createArtist({ name: 'Faceless' })
    const gone = await remoteImage('https://coverartarchive.org/release-group/97fd1d3f-30e3-40a1-96d8-98e002038093/front-500', { kind: 'cover' })
    await db.update(albums).set({ artworkAssetId: gone.id }).where(eq(albums.id, album.albumId))
    await db.update(artists).set({ imageAssetId: gone.id }).where(eq(artists.id, artist.id))
    expect(body(await get(`/albums/${album.albumId}`), AlbumDetail).artwork?.id).toBe(gone.id)
    expect(body(await get(`/artists/${artist.id}`), ArtistDetail).image?.id).toBe(gone.id)

    const keys = await notifiedKeys(async () => {
      expect((await app.inject({ url: `/api/v1/art/${gone.id}/300` })).statusCode).toBe(404)
    })
    expect(keys).toEqual(expect.arrayContaining([['album', album.albumId], ['artist', artist.id]]))
    expect(body(await get(`/albums/${album.albumId}`), AlbumDetail).artwork).toBeNull()
    expect(body(await get(`/artists/${artist.id}`), ArtistDetail).image).toBeNull()
  })

  it('drops reads when a discography adopts an album stub', async () => {
    const artistId = await artistStub({ name: 'Adopting Artist', mbid: 'b0000000-0000-4000-8000-000000000001' })
    const { albumId: stub } = await albumStub({ title: 'Adopted', artist: 'Adopting Artist', artistId })
    await get(`/albums/${stub}`)
    expect(readCacheStats().entries).toBe(1)
    const group: MbReleaseGroupSummary = {
      mbid: 'b0000000-0000-4000-8000-000000000002', title: 'Adopted', type: 'album', primaryType: 'album', secondaryTypes: [],
      disambiguation: '', date: '2020', year: 2020, artistName: 'Adopting Artist',
      artistCredit: [{ name: 'Adopting Artist', mbid: 'b0000000-0000-4000-8000-000000000001', joinPhrase: '' }],
    }
    // The new-release job writes discographies in the worker and announces only Home.
    const keys = await notifiedKeys(() => upsertDiscography([group]))
    expect(keys).toContainEqual(['album', stub])
    expect(readCacheStats().entries).toBe(0)
  })

  it('drops reads when old stubs are deleted', async () => {
    const { albumId: stub } = await albumStub({ title: 'Forgotten', artist: 'Forgotten Artist' })
    await db.execute(sql`update albums set created_at = now() - make_interval(days => ${stubMaxAgeDays + 1}) where id = ${stub}`)
    expect((await get(`/albums/${stub}`)).statusCode).toBe(200)

    const keys = await notifiedKeys(async () => expect((await cleanupStubs()).albums).toBeGreaterThan(0))
    expect(keys).toContainEqual(['album'])
    expect((await get(`/albums/${stub}`)).statusCode).toBe(404)
  })
})
