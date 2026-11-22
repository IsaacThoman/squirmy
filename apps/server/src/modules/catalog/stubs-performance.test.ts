/**
 * The library lists on a server that streams through a provider: 200,000 search stubs, a
 * library of 50 albums (30 in the collection, 20 saved, half of those with cached files),
 * and 2,000 more albums with cached files from playing that are in no library. Slow to
 * seed, so it only runs with SQUIRMY_PERF=1, like performance.test.ts:
 *
 *   SQUIRMY_PERF=1 npx vitest run src/modules/catalog/stubs-performance.test.ts --reporter=verbose
 *
 * Walking the catalog's sort index would read every stub for one page; these pages must
 * be read from the library's members instead (`libraryShape`).
 */
import { AlbumPage, ArtistPage, TrackPage } from '@squirmy/contracts'
import { sql, type SQL } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from '../../app.js'
import { db } from '../../database/client.js'
import { body, signIn } from '../../test/api.js'
import { useTestDatabase } from '../../test/database.js'
import { seedStubCatalog } from '../../test/library-seed.js'
import { libraryAlbumsQuery, libraryArtistsQuery, libraryGenresQuery, libraryShape, libraryShapeQuery, libraryTracksQuery } from './library.js'

const TRACKS_PER_ALBUM = 12

async function explain(query: SQL) {
  const [row] = await db.execute<{ 'QUERY PLAN': [{ 'Execution Time': number }] }>(sql`explain (analyze, format json) ${query}`)
  return row!['QUERY PLAN'][0]['Execution Time']
}

describe.skipIf(!process.env.SQUIRMY_PERF)('library lists in a catalog of stubs', () => {
  useTestDatabase()
  let app: FastifyInstance
  let user: Awaited<ReturnType<typeof signIn>>
  const report: string[] = []

  beforeAll(async () => {
    app = await buildApp()
    user = await signIn()
    const started = performance.now()
    await seedStubCatalog({ stubs: 200_000, artists: 20_000, collectionAlbums: 30, savedAlbums: 20, fetchedAlbums: 2_000, tracksPerAlbum: TRACKS_PER_ALBUM, userId: user.id })
    report.push(`seeded in ${Math.round(performance.now() - started)} ms`)
  }, 600_000)
  afterEach(() => {
    console.log(report.splice(0).join('\n'))
  })
  afterAll(async () => {
    await app.close()
  })

  it('lists exactly the library, each page read from its members', async () => {
    expect(await libraryShape(user.id, 'albums')).toBe('small')
    expect(await libraryShape(user.id, 'tracks')).toBe('small')
    const cases: [string, SQL][] = [
      ['albums shape', libraryShapeQuery(user.id, 'albums')],
      ['tracks shape', libraryShapeQuery(user.id, 'tracks')],
    ]
    for (const sort of ['recent', 'title', 'artist', 'year'] as const) cases.push([`albums ${sort}`, libraryAlbumsQuery(user.id, { sort, limit: 50 }, 'small')])
    for (const sort of ['recent', 'title', 'artist'] as const) cases.push([`tracks ${sort}`, libraryTracksQuery(user.id, { sort, limit: 50 }, 'small')])
    cases.push(['artists', libraryArtistsQuery(user.id, { limit: 50 }, 'small')], ['genres', libraryGenresQuery(user.id, { limit: 50 }, 'small')])
    for (const [name, query] of cases) {
      const time = await explain(query)
      report.push(`query ${name}: ${time.toFixed(2)} ms`)
      expect(time, name).toBeLessThan(50)
    }

    // Cached files of albums nobody saved stay out; saved albums count before their files arrive.
    for (const sort of ['recent', 'title', 'artist', 'year']) {
      const albums = body(await app.inject({ url: `/api/v1/library/albums?sort=${sort}&limit=200`, headers: user.headers }), AlbumPage)
      expect(albums.items, sort).toHaveLength(50)
    }
    const tracks = body(await app.inject({ url: '/api/v1/library/tracks?sort=title&limit=500', headers: user.headers }), TrackPage)
    expect(tracks.items).toHaveLength((30 + 10) * TRACKS_PER_ALBUM)
    const artists = body(await app.inject({ url: '/api/v1/library/artists?limit=200', headers: user.headers }), ArtistPage)
    expect(artists.items).toHaveLength(50)
  }, 120_000)
})
