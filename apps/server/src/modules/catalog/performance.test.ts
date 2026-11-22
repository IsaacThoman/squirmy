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
import { updateServerSettings } from '../../lib/settings.js'
import { signIn } from '../../test/api.js'
import { useTestDatabase } from '../../test/database.js'
import { seedLargeLibrary } from '../../test/library-seed.js'
import { libraryAlbumsQuery, libraryArtistsQuery, libraryGenresQuery, libraryShape, libraryShapeQuery, libraryTracksQuery } from './library.js'

const ALBUMS = 10_000
const TRACKS_PER_ALBUM = 15

/** Execution time, the faster of two runs: a freshly seeded database starts with a cold buffer cache. */
async function explain(query: SQL) {
  const times: number[] = []
  for (let run = 0; run < 2; run++) {
    const [row] = await db.execute<{ 'QUERY PLAN': [{ 'Execution Time': number }] }>(sql`explain (analyze, format json) ${query}`)
    times.push(row!['QUERY PLAN'][0]['Execution Time'])
  }
  return Math.min(...times)
}

describe.skipIf(!process.env.SQUIRMY_PERF)('catalog performance', () => {
  useTestDatabase()
  let app: FastifyInstance
  let user: Awaited<ReturnType<typeof signIn>>
  const report: string[] = []

  beforeAll(async () => {
    app = await buildApp()
    user = await signIn()
    // Time the wantlist queries rather than the answer for a switched-off wantlist.
    await updateServerSettings({ wantlistEnabled: true })
    const started = performance.now()
    await seedLargeLibrary({ albums: ALBUMS, tracksPerAlbum: TRACKS_PER_ALBUM, artists: 2_000, unownedEvery: 10, userId: user.id, plays: 50_000, likes: 2_000 })
    // Saves next to the collection: albums without files, and tracks of them.
    await db.execute(sql`
      insert into library_items (user_id, entity_type, entity_id, created_at)
      select ${user.id}, 'album', a.id, timestamptz '2026-01-01' + n * interval '20 minutes'
      from (select id, row_number() over (order by id) as n from albums a
        where not exists (select 1 from media_files f where f.album_id = a.id) limit 500) a`)
    await db.execute(sql`
      insert into library_items (user_id, entity_type, entity_id, created_at)
      select ${user.id}, 'recording', rt.recording_id, timestamptz '2026-01-01' + n * interval '15 minutes'
      from (select rt.recording_id, row_number() over (order by rt.recording_id) as n from release_tracks rt
        where not exists (select 1 from media_files f where f.recording_id = rt.recording_id) limit 500) rt`)
    await db.execute(sql`analyze library_items`)
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
    const albums = await libraryShape(user.id, 'albums')
    const tracks = await libraryShape(user.id, 'tracks')
    expect([albums, tracks]).toEqual(['large', 'large'])
    for (const kind of ['albums', 'tracks'] as const) {
      const time = await explain(libraryShapeQuery(user.id, kind))
      report.push(`query ${kind} shape: ${time.toFixed(2)} ms`)
      expect(time, `${kind} shape`).toBeLessThan(50)
    }
    const cases: [string, (cursor?: string) => SQL, string][] = []
    for (const sort of ['recent', 'title', 'artist', 'year'] as const) {
      cases.push([`albums ${sort}`, (cursor) => libraryAlbumsQuery(user.id, { sort, limit: 50, cursor }, albums), `/api/v1/library/albums?sort=${sort}`])
    }
    cases.push(['albums genre=Jazz by title', (cursor) => libraryAlbumsQuery(user.id, { sort: 'title', genre: 'Jazz', limit: 50, cursor }, albums), '/api/v1/library/albums?sort=title&genre=Jazz'])
    for (const sort of ['recent', 'title', 'artist'] as const) {
      cases.push([`tracks ${sort}`, (cursor) => libraryTracksQuery(user.id, { sort, limit: 50, cursor }, tracks), `/api/v1/library/tracks?sort=${sort}`])
    }
    cases.push(['tracks genre=Jazz by title', (cursor) => libraryTracksQuery(user.id, { sort: 'title', genre: 'Jazz', limit: 50, cursor }, tracks), '/api/v1/library/tracks?sort=title&genre=Jazz'])
    cases.push(['artists', (cursor) => libraryArtistsQuery(user.id, { limit: 50, cursor }, albums), '/api/v1/library/artists'])

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
    report.push(`query genres: ${(await explain(libraryGenresQuery(user.id, { limit: 50 }, albums))).toFixed(2)} ms`)
    // Tracks by year sort the library's files, so they are timed but have no index to keep.
    report.push(`query tracks year: ${(await explain(libraryTracksQuery(user.id, { sort: 'year', limit: 50 }, tracks))).toFixed(2)} ms`)
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
    await route('/api/v1/me/wants?limit=50')
    await route('/api/v1/playlists?limit=50')
    await route('/api/v1/library/genres')
  }, 300_000)
})
