import { SearchResults } from '@squirmy/contracts'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { buildApp } from '../../app.js'
import { body, signIn } from '../../test/api.js'
import { useTestDatabase } from '../../test/database.js'
import { createAlbum, createArtist } from '../../test/factories.js'
import { useHttpFixtures } from '../../test/http.js'

// Detail runs are replaced so the test sees which albums are warmed and when, without the
// MusicBrainz and Deezer calls a real run makes.
const runs = vi.hoisted(() => ({ started: [] as string[], finish: new Map<string, () => void>() }))
vi.mock('../enrichment/album.js', () => ({
  hydrateAlbum: (albumId: string) => {
    runs.started.push(albumId)
    return new Promise<void>((resolve) => runs.finish.set(albumId, resolve))
  },
}))

const { setAlbumWarming, warmAlbums } = await import('./warm.js')

/** Lets the `finally` of a finished run start the next one. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

async function finish(albumId: string) {
  runs.finish.get(albumId)!()
  await settle()
}

describe('warming catalog search albums', () => {
  useTestDatabase()
  useHttpFixtures('deezer')
  let app: FastifyInstance
  let user: Awaited<ReturnType<typeof signIn>>

  beforeAll(async () => {
    app = await buildApp()
    user = await signIn()
    setAlbumWarming(true)
  })
  afterAll(async () => {
    setAlbumWarming(false)
    await app.close()
  })

  it('fetches the top album and the first albums without a track list in the background, two at a time', async () => {
    // A catalog album that already has its track list.
    const complete = await createAlbum({ title: 'OK Computer', artist: await createArtist({ name: 'Radiohead' }), tracks: [{ title: 'Airbag' }] })
    const results = body(await app.inject({ url: '/api/v1/search/catalog?q=Radiohead+OK+Computer&limit=5', headers: user.headers }), SearchResults)
    expect(results.albums.map((album) => album.id)).toContain(complete.albumId)
    const stubs = results.albums.filter((album) => album.trackCount === 0).map((album) => album.id)
    expect(stubs).toHaveLength(4)

    // The top result goes first, track list or not: it is the page most likely opened. The
    // answer did not wait for any of them.
    expect(results.top).toMatchObject({ type: 'album', id: complete.albumId })
    const order = [complete.albumId, ...stubs]
    expect(runs.started).toEqual(order.slice(0, 2))
    await finish(order[0]!)
    expect(runs.started).toEqual(order.slice(0, 3))
    for (const albumId of order.slice(1)) await finish(albumId)
    expect(runs.started).toEqual(order)
  })

  it('puts a newer search ahead of what an older one left waiting, five at most', async () => {
    runs.started.length = 0
    warmAlbums(['a1', 'a2', 'a3', 'a4', 'a5', 'a6'])
    expect(runs.started).toEqual(['a1', 'a2'])
    warmAlbums(['b1', 'a2', 'b2', 'b3', 'b4'])
    await finish('a1')
    // a2 is already running and is not started twice; the newer search's albums go first,
    // and of the older one's only what fits in five waits.
    expect(runs.started).toEqual(['a1', 'a2', 'b1'])
    for (const albumId of ['a2', 'b1', 'b2', 'b3', 'b4', 'a3']) await finish(albumId)
    expect(runs.started).toEqual(['a1', 'a2', 'b1', 'b2', 'b3', 'b4', 'a3'])
  })
})
