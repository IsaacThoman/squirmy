/**
 * Subsonic on a server that streams through a provider: 200,000 search stubs, a library of
 * 50 albums (30 in the collection, 20 saved, half of those with cached files) and 2,000
 * more albums with cached files from playing that are in no library. Slow to seed, so it
 * only runs with SQUIRMY_PERF=1, like performance.test.ts:
 *
 *   SQUIRMY_PERF=1 npx vitest run src/modules/subsonic/stubs-performance.test.ts --reporter=verbose
 *
 * Checks that the lists hold exactly the library with a present file (decision 41), and
 * fails when a call takes over 500 ms, as performance.test.ts does.
 */
import type { FastifyInstance } from 'fastify'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from '../../app.js'
import { useTestDatabase } from '../../test/database.js'
import { createUser } from '../../test/factories.js'
import { seedStubCatalog } from '../../test/library-seed.js'
import { subsonicClient, type SubsonicClient } from '../../test/subsonic-client.js'
import { createAppPassword } from '../auth/service.js'

const TRACKS_PER_ALBUM = 12
/** The collection's 30 albums, and the 10 saved ones whose files have arrived. */
const LISTED_ALBUMS = 40

describe.skipIf(!process.env.SQUIRMY_PERF)('subsonic in a catalog of stubs', () => {
  useTestDatabase()
  let app: FastifyInstance
  let client: SubsonicClient
  const report: string[] = []

  beforeAll(async () => {
    app = await buildApp()
    const user = await createUser({ username: 'mira', settings: { libraryIncludesServerMusic: true } })
    client = subsonicClient(app, { username: 'mira', secret: (await createAppPassword(user.id, 'perf')).secret! })
    await seedStubCatalog({ stubs: 200_000, artists: 20_000, collectionAlbums: 30, savedAlbums: 20, fetchedAlbums: 2_000, tracksPerAlbum: TRACKS_PER_ALBUM, userId: user.id })
  }, 600_000)
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

  it('lists the library and nothing fetched for playing', async () => {
    for (const type of ['newest', 'alphabeticalByName', 'alphabeticalByArtist', 'random', 'byYear']) {
      await time(`getAlbumList2 type=${type} size=500`, 'getAlbumList2', { type, size: 500, fromYear: 1900, toYear: 2100 }, (body) => {
        expect(body.albumList2.album).toHaveLength(LISTED_ALBUMS)
      })
    }
    await time('search3 query="" (500 of each)', 'search3', { query: '', songCount: 500, albumCount: 500, artistCount: 500 }, (body) => {
      expect(body.searchResult3.album).toHaveLength(LISTED_ALBUMS)
      expect(body.searchResult3.song).toHaveLength(LISTED_ALBUMS * TRACKS_PER_ALBUM)
      expect(body.searchResult3.artist.length).toBeGreaterThan(0)
    })
    await time('search3 query="track"', 'search3', { query: 'track' }, () => {})
    await time('getArtists', 'getArtists', {}, (body) => {
      expect(body.artists.index.flatMap((index: { artist: unknown[] }) => index.artist).length).toBeLessThanOrEqual(LISTED_ALBUMS)
    })
    await time('getIndexes', 'getIndexes', {}, () => {})
    await time('getGenres', 'getGenres', {}, () => {})
    await time('getRandomSongs size=500', 'getRandomSongs', { size: 500 }, (body) => {
      expect(body.randomSongs.song).toHaveLength(LISTED_ALBUMS * TRACKS_PER_ALBUM)
    })
  }, 300_000)
})
