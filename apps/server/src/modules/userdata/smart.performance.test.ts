/**
 * Timings of smart playlist evaluation on a large synthetic library (10,000 albums, 150,000
 * tracks with files, 50,000 plays). Slow to seed, so it only runs with SQUIRMY_PERF=1:
 *
 *   SQUIRMY_PERF=1 npx vitest run src/modules/userdata/smart.performance.test.ts --reporter=verbose
 *
 * A smart playlist is evaluated on every read of it, so each rule set must stay one pass over
 * the files: it fails when one takes over a second (about 100 to 400 ms on an idle laptop).
 */
import { SmartPlaylistRules } from '@squirmy/contracts'
import { sql, type SQL } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { db } from '../../database/client.js'
import { signIn } from '../../test/api.js'
import { useTestDatabase } from '../../test/database.js'
import { seedLargeLibrary } from '../../test/library-seed.js'
import { smartTracksQuery } from './smart.js'

async function explain(query: SQL) {
  const times: number[] = []
  for (let run = 0; run < 2; run++) {
    // As `smartTracks` runs it.
    const [row] = await db.transaction(async (tx) => {
      await tx.execute(sql`set local work_mem = '32MB'`)
      return tx.execute<{ 'QUERY PLAN': [{ 'Execution Time': number }] }>(sql`explain (analyze, format json) ${query}`)
    })
    times.push(row!['QUERY PLAN'][0]['Execution Time'])
  }
  return Math.min(...times)
}

const cases: [string, unknown][] = [
  ['everything, by title', { source: 'server', match: 'all', conditions: [], sort: 'title', limit: null }],
  ['random 50', { source: 'server', match: 'all', conditions: [], sort: 'random', limit: 50 }],
  ['jazz from the 70s, most played', {
    source: 'library', match: 'all', sort: 'mostPlayed', limit: 100,
    conditions: [{ field: 'genre', op: 'is', value: 'Jazz' }, { field: 'decade', op: 'is', value: 1970 }],
  }],
  ['artist contains, any of two', {
    source: 'library', match: 'any', sort: 'artist', limit: null,
    conditions: [{ field: 'artist', op: 'contains', value: 'artist 1a' }, { field: 'title', op: 'contains', value: 'track 0' }],
  }],
  ['not played in a month, liked, lossless', {
    source: 'library', match: 'all', sort: 'recentlyAdded', limit: 200,
    conditions: [
      { field: 'lastPlayed', op: 'notInLast', value: 1, unit: 'months' },
      { match: 'any', conditions: [{ field: 'liked', value: true }, { field: 'rating', op: 'gt', value: 3 }] },
      { field: 'lossless', value: true },
    ],
  }],
]

describe.skipIf(!process.env.SQUIRMY_PERF)('smart playlist performance', () => {
  useTestDatabase()
  let user: Awaited<ReturnType<typeof signIn>>
  const report: string[] = []

  beforeAll(async () => {
    user = await signIn({ settings: { libraryIncludesServerMusic: true } })
    await seedLargeLibrary({ albums: 10_000, tracksPerAlbum: 15, artists: 2_000, unownedEvery: 10, userId: user.id, plays: 50_000, likes: 2_000 })
  }, 300_000)
  afterAll(() => {
    console.log(report.join('\n'))
  })

  for (const [name, raw] of cases) {
    it(name, async () => {
      const rules = SmartPlaylistRules.parse(raw)
      const ms = await explain(smartTracksQuery(user.id, rules, 'seed'))
      report.push(`${name}: ${ms.toFixed(1)} ms`)
      expect(ms).toBeLessThan(1000)
    })
  }
})
