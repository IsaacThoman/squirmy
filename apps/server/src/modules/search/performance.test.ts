/**
 * Timings of library search on a large synthetic library (10,000 albums, 150,000
 * tracks). Slow to seed, so it only runs with SQUIRMY_PERF=1:
 *
 *   SQUIRMY_PERF=1 npx vitest run src/modules/search/performance.test.ts --reporter=verbose
 *
 * It prints EXPLAIN ANALYZE planning plus execution time per kind and query (warm), and
 * the wall time of the route, and fails if a query takes over 30 ms of database time.
 */
import { sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from '../../app.js'
import { db } from '../../database/client.js'
import { signIn } from '../../test/api.js'
import { useTestDatabase } from '../../test/database.js'
import { seedLargeLibrary } from '../../test/library-seed.js'
import { matchKey } from '../../lib/text.js'
import { libraryQuery, seqScanOff, type LibraryKind } from './library.js'

describe.skipIf(!process.env.SQUIRMY_PERF)('library search performance', () => {
  useTestDatabase()
  let app: FastifyInstance
  let user: Awaited<ReturnType<typeof signIn>>

  beforeAll(async () => {
    app = await buildApp()
    user = await signIn()
    await seedLargeLibrary({ albums: 10_000, tracksPerAlbum: 15, artists: 2_000, unownedEvery: 10, userId: user.id, plays: 50_000, likes: 2_000 })
  }, 300_000)
  afterAll(async () => {
    await app.close()
  })

  it('answers every kind of query within 30 ms of database time', async () => {
    const [sample] = await db.execute<{ artist: string; album: string; track: string }>(sql`
      select ar.name as artist, al.title as album, r.title as track
      from albums al join artists ar on ar.id = al.primary_artist_id join recordings r on r.primary_artist_id = ar.id
      where exists (select 1 from media_files f where f.album_id = al.id) limit 1`)
    const { artist, album, track } = sample!
    const typo = (text: string) => text.slice(0, -4) + text.slice(-3) // drops one character
    const queries = [
      'ar', 'artist', 'track', 'the', 'zzzzqq',
      album.slice(0, 10), track, typo(track), typo(artist),
      `${artist} ${track.slice(0, 12)}`, `${track} ${artist}`,
    ]
    const report: string[] = []
    let worst = 0
    for (const query of queries) {
      const key = matchKey(query)
      const times: string[] = []
      for (const kind of ['artist', 'album', 'track'] as LibraryKind[]) {
        const [row] = await db.transaction(async (tx) => {
          await tx.execute(seqScanOff)
          for (let run = 0; run < 2; run++) await tx.execute(libraryQuery(kind, user.id, key, 10))
          return tx.execute<{ 'QUERY PLAN': [{ 'Planning Time': number; 'Execution Time': number }] }>(sql`explain (analyze, format json) ${libraryQuery(kind, user.id, key, 10)}`)
        })
        const plan = row!['QUERY PLAN'][0]
        const ms = plan['Planning Time'] + plan['Execution Time']
        worst = Math.max(worst, ms)
        times.push(`${kind} ${ms.toFixed(1)}`)
      }
      const started = performance.now()
      const response = await app.inject({ url: `/api/v1/search/library?q=${encodeURIComponent(query)}`, headers: user.headers })
      expect(response.statusCode).toBe(200)
      report.push(`${JSON.stringify(query).padEnd(48)} ${times.join(' ms, ')} ms; route ${(performance.now() - started).toFixed(1)} ms`)
    }
    console.log(report.join('\n'))
    expect(worst).toBeLessThan(30)
  }, 120_000)
})
