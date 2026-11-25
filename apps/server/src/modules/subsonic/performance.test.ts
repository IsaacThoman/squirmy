/**
 * Timings of the paging methods on a large synthetic library (10,000 albums, 150,000
 * tracks). Slow to seed, so it only runs with SQUIRMY_PERF=1:
 *
 *   SQUIRMY_PERF=1 npx vitest run src/modules/subsonic/performance.test.ts
 *
 * Prints the median of five calls for each case and fails when one takes over 500 ms, which
 * catches a lost index or a query per row even on a busy machine.
 */
import type { FastifyInstance } from 'fastify'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from '../../app.js'
import { useTestDatabase } from '../../test/database.js'
import { createUser } from '../../test/factories.js'
import { seedLargeLibrary } from '../../test/library-seed.js'
import { createAppPassword } from '../auth/service.js'
import { subsonicClient, type SubsonicClient } from '../../test/subsonic-client.js'

describe.skipIf(!process.env.SQUIRMY_PERF)('subsonic performance', () => {
  useTestDatabase()
  let app: FastifyInstance
  let client: SubsonicClient
  const report: string[] = []

  beforeAll(async () => {
    app = await buildApp()
    const user = await createUser({ username: 'mira', settings: { libraryIncludesServerMusic: true } })
    client = subsonicClient(app, { username: 'mira', secret: (await createAppPassword(user.id, 'perf')).secret! })
    await seedLargeLibrary({ albums: 10_000, tracksPerAlbum: 15, artists: 2_000, unownedEvery: 10, userId: user.id, plays: 50_000, likes: 2_000 })
  }, 300_000)
  afterEach(() => {
    console.log(report.splice(0).join('\n'))
  })
  afterAll(async () => {
    await app.close()
  })

  async function time(label: string, endpoint: string, params: Record<string, string | number>, check: (body: Record<string, any>) => void) {
    const times: number[] = []
    for (let run = 0; run < 5; run++) {
      const started = performance.now()
      const body = await client.json(endpoint, params)
      times.push(performance.now() - started)
      expect(body.status, JSON.stringify(body.error)).toBe('ok')
      check(body)
    }
    const median = times.sort((a, b) => a - b)[2]!
    report.push(`${label.padEnd(58)} ${median.toFixed(1).padStart(7)} ms`)
    expect(median, label).toBeLessThan(500)
  }

  it('pages album lists', async () => {
    const owned = 9_000
    for (const type of ['newest', 'alphabeticalByName', 'alphabeticalByArtist', 'random', 'frequent', 'recent']) {
      for (const offset of [0, owned - 500]) {
        if (type === 'random' && offset > 0) continue
        await time(`getAlbumList2 type=${type} size=500 offset=${offset}`, 'getAlbumList2', { type, size: 500, offset }, (body) => {
          expect(body.albumList2.album.length).toBeGreaterThan(0)
        })
      }
    }
    await time('getAlbumList2 type=byGenre genre=Jazz size=50 offset=500', 'getAlbumList2', { type: 'byGenre', genre: 'Jazz', size: 50, offset: 500 }, (body) => {
      expect(body.albumList2.album).toHaveLength(50)
    })
  }, 300_000)

  it('pages through everything with an empty search3', async () => {
    const ownedTracks = 135_000
    // A jump straight to a deep offset counts past the earlier rows.
    for (const offset of [0, 50_000, ownedTracks - 500]) {
      await time(`search3 query="" songCount=500 songOffset=${offset} (jump)`, 'search3', { query: '', songCount: 500, songOffset: offset, artistCount: 0, albumCount: 0 }, (body) => {
        expect(body.searchResult3.song).toHaveLength(500)
      })
    }
    // A sync client asks for each page in turn, which continues from the last key.
    const pages: number[] = []
    const seen = new Set<string>()
    const started = performance.now()
    for (let offset = 0; ; offset += 500) {
      const pageStarted = performance.now()
      const body = await client.json('search3', { query: '', songCount: 500, songOffset: offset, artistCount: 0, albumCount: 0 })
      pages.push(performance.now() - pageStarted)
      if (body.searchResult3.song.length === 0) break
      for (const song of body.searchResult3.song) seen.add(song.id)
    }
    expect(seen.size).toBe(ownedTracks)
    const sorted = [...pages].sort((a, b) => a - b)
    report.push(`search3 query="" full sync, ${pages.length} pages of 500: median ${sorted[Math.floor(sorted.length / 2)]!.toFixed(1)} ms, p95 ${sorted[Math.floor(sorted.length * 0.95)]!.toFixed(1)} ms, max ${sorted.at(-1)!.toFixed(1)} ms, total ${((performance.now() - started) / 1000).toFixed(1)} s`)
    expect(sorted[Math.floor(sorted.length * 0.95)]!).toBeLessThan(500)

    await time('search3 query="" albumCount=500 albumOffset=8500', 'search3', { query: '', albumCount: 500, albumOffset: 8_500, artistCount: 0, songCount: 0 }, (body) => {
      expect(body.searchResult3.album).toHaveLength(500)
    })
    await time('search3 query="" artistCount=500 artistOffset=1300', 'search3', { query: '', artistCount: 500, artistOffset: 1_300, albumCount: 0, songCount: 0 }, (body) => {
      expect(body.searchResult3.artist).toHaveLength(500)
    })
    await time('search3 query="track 1a" (20 of each)', 'search3', { query: 'track 1a' }, () => {})
  }, 600_000)

  it('lists every artist and genre', async () => {
    // 200 of the 2,000 seeded artists have only albums nobody owns.
    await time('getArtists (1,800 artists)', 'getArtists', {}, (body) => {
      expect(body.artists.index.flatMap((index: { artist: unknown[] }) => index.artist)).toHaveLength(1_800)
    })
    await time('getIndexes', 'getIndexes', {}, () => {})
    await time('getGenres', 'getGenres', {}, (body) => {
      expect(body.genres.genre).toHaveLength(12)
    })
    await time('getRandomSongs size=500', 'getRandomSongs', { size: 500 }, (body) => {
      expect(body.randomSongs.song).toHaveLength(500)
    })
    await time('getStarred2 (2,000 starred songs)', 'getStarred2', {}, () => {})
  }, 300_000)
})
