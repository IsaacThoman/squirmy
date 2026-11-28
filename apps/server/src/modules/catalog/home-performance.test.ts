/**
 * Timings of the personal Home on a heavy listener: 500,000 plays (one every three
 * minutes, almost three years) over a library of 10,000 albums. Slow to seed, so it only
 * runs with SQUIRMY_PERF=1:
 *
 *   SQUIRMY_PERF=1 npx vitest run src/modules/catalog/home-performance.test.ts --reporter=verbose
 *
 * It prints EXPLAIN ANALYZE execution times of Home's queries over plays, the wall time of
 * a day's picks run and of `GET /home`, and fails if a query Home runs on every read takes
 * over 50 ms.
 */
import { sql, type SQL } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from '../../app.js'
import { db } from '../../database/client.js'
import { updateServerSettings } from '../../lib/settings.js'
import { signIn } from '../../test/api.js'
import { useTestDatabase } from '../../test/database.js'
import { seedLargeLibrary } from '../../test/library-seed.js'
import { jumpBackInQuery, mostPlayedQuery } from './home.js'
import { hourlyQuery, makeHomePicks, rediscoverQuery, topArtistsQuery } from './home-picks.js'

const PLAYS = 500_000

async function explain(query: SQL) {
  const times: number[] = []
  for (let run = 0; run < 2; run++) {
    const [row] = await db.execute<{ 'QUERY PLAN': [{ 'Execution Time': number }] }>(sql`explain (analyze, format json) ${query}`)
    times.push(row!['QUERY PLAN'][0]['Execution Time'])
  }
  return Math.min(...times)
}

describe.skipIf(!process.env.SQUIRMY_PERF)('home performance', () => {
  useTestDatabase()
  let app: FastifyInstance
  let user: Awaited<ReturnType<typeof signIn>>
  const report: string[] = []

  beforeAll(async () => {
    app = await buildApp()
    await updateServerSettings({ deezerEnabled: false })
    user = await signIn()
    const started = performance.now()
    await seedLargeLibrary({ albums: 10_000, tracksPerAlbum: 15, artists: 2_000, unownedEvery: 10, userId: user.id, plays: PLAYS, likes: 2_000 })
    // Half the plays from an album page, a tenth from a radio, a few skipped.
    await db.execute(sql`
      update plays set
        context_type = case when id::text < '8' then 'album' when id::text < '9' then 'radio' else null end,
        context_id = case when id::text < '8' then album_id::text when id::text < '9' then 'artist:' || gen_random_uuid() else null end,
        skipped = id::text > 'fa', completed = completed and id::text <= 'fa'
      where user_id = ${user.id}`)
    await db.execute(sql`vacuum (analyze) plays`)
    report.push(`seeded ${PLAYS.toLocaleString('en')} plays in ${Math.round(performance.now() - started)} ms`)
  }, 600_000)
  afterAll(async () => {
    console.log(report.join('\n'))
    await app.close()
  })

  it('keeps Home’s queries over plays fast', async () => {
    const cases: [string, SQL, number][] = [
      ['jump back in', jumpBackInQuery(user.id), 50],
      ['most played', mostPlayedQuery(user.id), 50],
      // Made once a day in the background, not on a read.
      ['top artists (daily)', topArtistsQuery(user.id), 2_000],
      ['time of day (daily)', hourlyQuery(user.id), 2_000],
      ['rediscover (daily)', rediscoverQuery(user.id), 2_000],
    ]
    for (const [name, query, budget] of cases) {
      const time = await explain(query)
      report.push(`query ${name}: ${time.toFixed(2)} ms`)
      expect(time, name).toBeLessThan(budget)
    }
  }, 300_000)

  it('makes a day’s picks and serves Home quickly', async () => {
    const started = performance.now()
    await makeHomePicks(user.id)
    report.push(`picks run: ${Math.round(performance.now() - started)} ms`)
    for (const url of ['/api/v1/home?layout=personal&tz=Europe/Berlin', '/api/v1/home']) {
      const times: number[] = []
      for (let run = 0; run < 5; run++) {
        const at = performance.now()
        const response = await app.inject({ url, headers: user.headers })
        times.push(performance.now() - at)
        expect(response.statusCode, response.body).toBe(200)
      }
      report.push(`route GET ${url}: ${times.sort((a, b) => a - b)[2]!.toFixed(1)} ms (median of 5, uncached)`)
    }
  }, 300_000)
})
