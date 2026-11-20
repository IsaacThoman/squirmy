/**
 * Suggestion timings on a large synthetic library (10,000 albums, 150,000 tracks, 50,000
 * plays). Slow to seed, so it only runs with SQUIRMY_PERF=1:
 *
 *   SQUIRMY_PERF=1 npx vitest run src/modules/radio/performance.test.ts --reporter=verbose
 *
 * External sources are off, so the time measured is the database's plus a little ranking.
 * It fails if an autoplay batch takes 100 ms or more.
 */
import { sql } from 'drizzle-orm'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { db } from '../../database/client.js'
import { updateServerSettings } from '../../lib/settings.js'
import { useTestDatabase } from '../../test/database.js'
import { createUser } from '../../test/factories.js'
import { seedLargeLibrary } from '../../test/library-seed.js'
import { suggest } from './ranking.js'

const RUNS = 20

describe.skipIf(!process.env.SQUIRMY_PERF)('radio performance', () => {
  useTestDatabase()
  let userId: string
  let seeds: string[][]
  const report: string[] = []

  beforeAll(async () => {
    await updateServerSettings({ deezerEnabled: false })
    userId = (await createUser()).id
    const started = performance.now()
    await seedLargeLibrary({ albums: 10_000, tracksPerAlbum: 15, artists: 2_000, unownedEvery: 10, userId, plays: 50_000, likes: 2_000 })
    report.push(`seeded in ${Math.round(performance.now() - started)} ms`)
    // Ten-track histories, as autoplay sends them: a few owned tracks the user has played.
    const played = await db.execute<{ id: string }>(sql`
      select distinct p.recording_id as id from plays p
      where exists (select 1 from media_files mf where mf.recording_id = p.recording_id and mf.missing_since is null)
      limit ${RUNS * 10}`)
    seeds = Array.from({ length: RUNS }, (_, run) => played.slice(run * 10, run * 10 + 10).map((row) => row.id))
  }, 300_000)
  afterEach(() => {
    console.log(report.splice(0).join('\n'))
  })

  async function time(limit: number) {
    const times: number[] = []
    for (const history of seeds) {
      const started = performance.now()
      const result = await suggest({ userId, seeds: history, exclude: [], limit })
      times.push(performance.now() - started)
      expect(result).toHaveLength(limit)
    }
    times.sort((a, b) => a - b)
    return { median: times[Math.floor(times.length / 2)]!, p95: times[Math.floor(times.length * 0.95)]!, max: times.at(-1)! }
  }

  it('suggests an autoplay batch and a radio quickly', async () => {
    await suggest({ userId, seeds: seeds[0]!, exclude: [], limit: 10 })
    const batch = await time(10)
    report.push(`autoplay batch of 10: median ${batch.median.toFixed(1)} ms, p95 ${batch.p95.toFixed(1)} ms, max ${batch.max.toFixed(1)} ms`)
    const radio = await time(49)
    report.push(`radio of 49: median ${radio.median.toFixed(1)} ms, p95 ${radio.p95.toFixed(1)} ms, max ${radio.max.toFixed(1)} ms`)
    expect(batch.median).toBeLessThan(100)
  }, 300_000)
})
