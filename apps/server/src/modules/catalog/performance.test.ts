/**
 * Timings of the list and page queries on a large synthetic library (10,000 albums,
 * 150,000 tracks). Slow to seed, so it only runs with SQUIRMY_PERF=1:
 *
 *   SQUIRMY_PERF=1 npx vitest run src/modules/catalog/performance.test.ts --reporter=verbose
 *
 * It prints EXPLAIN ANALYZE execution times for first and deep pages and the wall time
 * of each route, and fails if a list query loses its index (over 50 ms).
 */
import { sql, type SQL } from 'drizzle-orm'
import type { FastifyInstance, LightMyRequestResponse } from 'fastify'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from '../../app.js'
import { db } from '../../database/client.js'
import { signIn } from '../../test/api.js'
import { useTestDatabase } from '../../test/database.js'
import { seedLargeLibrary } from '../../test/library-seed.js'
import { libraryAlbumsQuery, libraryArtistsQuery, libraryGenresQuery, libraryTracksQuery } from './library.js'

const ALBUMS = 10_000
const TRACKS_PER_ALBUM = 15

async function explain(query: SQL) {
  const [row] = await db.execute<{ 'QUERY PLAN': [{ 'Execution Time': number }] }>(sql`explain (analyze, format json) ${query}`)
  return row!['QUERY PLAN'][0]['Execution Time']
}

describe.skipIf(!process.env.SQUIRMY_PERF)('catalog performance', () => {
  useTestDatabase()
  let app: FastifyInstance
  let user: Awaited<ReturnType<typeof signIn>>
  const report: string[] = []

  beforeAll(async () => {
    app = await buildApp()
    user = await signIn()
    const started = performance.now()
    await seedLargeLibrary({ albums: ALBUMS, tracksPerAlbum: TRACKS_PER_ALBUM, artists: 2_000, unownedEvery: 10, userId: user.id, plays: 50_000, likes: 2_000 })
    report.push(`seeded in ${Math.round(performance.now() - started)} ms`)
  }, 300_000)
  afterEach(() => {
    console.log(report.splice(0).join('\n'))
  })
  afterAll(async () => {
    await app.close()
  })

  /** Cursor of the page that starts `pages * 200` rows in. */
  async function deepCursor(url: string, pages: number) {
    let cursor: string | null = null
    for (let page = 0; page < pages; page++) {
      const response: LightMyRequestResponse = await app.inject({ url: `${url}${url.includes('?') ? '&' : '?'}limit=200${cursor ? `&cursor=${cursor}` : ''}`, headers: user.headers })
      cursor = (response.json() as { nextCursor: string | null }).nextCursor
    }
    return cursor!
  }

  async function route(url: string, init: { method?: 'GET' | 'POST'; payload?: object } = {}) {
    const times: number[] = []
    for (let run = 0; run < 5; run++) {
      const started = performance.now()
      const response = await app.inject({ url, headers: user.headers, method: init.method ?? 'GET', payload: init.payload })
      times.push(performance.now() - started)
      expect(response.statusCode, response.body).toBe(200)
    }
    const median = times.sort((a, b) => a - b)[2]!
    report.push(`route ${init.method ?? 'GET'} ${url.replace(/cursor=[^&]+/, 'cursor=…')}: ${median.toFixed(1)} ms`)
  }

  it('keeps list queries on their indexes', async () => {
    const cases: [string, (cursor?: string) => SQL, string][] = []
    for (const sort of ['recent', 'title', 'artist', 'year'] as const) {
      cases.push([`albums ${sort}`, (cursor) => libraryAlbumsQuery({ sort, limit: 50, cursor }), `/api/v1/library/albums?sort=${sort}`])
    }
    cases.push(['albums genre=Jazz by title', (cursor) => libraryAlbumsQuery({ sort: 'title', genre: 'Jazz', limit: 50, cursor }), '/api/v1/library/albums?sort=title&genre=Jazz'])
    for (const sort of ['recent', 'title', 'artist'] as const) {
      cases.push([`tracks ${sort}`, (cursor) => libraryTracksQuery({ sort, limit: 50, cursor }), `/api/v1/library/tracks?sort=${sort}`])
    }
    cases.push(['artists', (cursor) => libraryArtistsQuery({ limit: 50, cursor }), '/api/v1/library/artists'])

    for (const [name, query, url] of cases) {
      const first = await explain(query())
      const cursor = await deepCursor(url, 3)
      const deep = await explain(query(cursor))
      report.push(`query ${name}: first page ${first.toFixed(2)} ms, after 600 rows ${deep.toFixed(2)} ms`)
      expect(first, name).toBeLessThan(50)
      expect(deep, name).toBeLessThan(50)
      const separator = url.includes('?') ? '&' : '?'
      await route(`${url}${separator}limit=50`)
      await route(`${url}${separator}limit=50&cursor=${cursor}`)
    }
    report.push(`query genres: ${(await explain(libraryGenresQuery({ limit: 50 }))).toFixed(2)} ms`)
  }, 300_000)

  it('serves pages and home quickly', async () => {
    const [album] = await db.execute<{ id: string }>(sql`select id from albums order by id limit 1`)
    const [artist] = await db.execute<{ id: string }>(sql`select primary_artist_id as id from albums group by 1 order by count(*) desc limit 1`)
    const tracks = await db.execute<{ id: string }>(sql`select id from recordings order by id limit 500`)
    await route(`/api/v1/albums/${album!.id}`)
    await route(`/api/v1/artists/${artist!.id}`)
    await route(`/api/v1/tracks/${tracks[0]!.id}`)
    await route('/api/v1/tracks/summaries', { method: 'POST', payload: { tracks: tracks.map((track) => ({ id: track.id })) } })
    await route('/api/v1/home')
    await route('/api/v1/me/history?limit=50')
    await route('/api/v1/me/likes/track?limit=50')
    await route('/api/v1/library/genres')
  }, 300_000)
})
