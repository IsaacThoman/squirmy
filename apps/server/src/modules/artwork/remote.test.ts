import { eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import sharp from 'sharp'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildApp } from '../../app.js'
import { db } from '../../database/client.js'
import { albums, artists, assets } from '../../database/schema.js'
import { updateServerSettings } from '../../lib/settings.js'
import { useTestDatabase } from '../../test/database.js'
import { createAlbum, createArtist } from '../../test/factories.js'
import { remoteImage, storeImage } from './store.js'

const picture = (color: string) => sharp({ create: { width: 64, height: 64, channels: 3, background: color } }).jpeg().toBuffer()

describe('remote images', () => {
  useTestDatabase()
  let app: FastifyInstance
  let served: Record<string, Buffer | number> = {}
  let fetches: string[] = []

  beforeAll(async () => { app = await buildApp() })
  afterAll(async () => { await app.close() })
  beforeEach(() => {
    served = {}
    fetches = []
    vi.stubGlobal('fetch', async (input: string | URL | Request) => {
      const url = input.toString()
      fetches.push(url)
      const body = served[url]
      if (typeof body === 'number' || body === undefined) return new Response('nope', { status: body ?? 404 })
      // Slow enough that two requests overlap.
      await new Promise((resolve) => setTimeout(resolve, 30))
      return new Response(new Uint8Array(body), { status: 200, headers: { 'content-type': 'image/jpeg' } })
    })
  })

  const art = (id: string, size = 300) => app.inject({ method: 'GET', url: `/api/v1/art/${id}/${size}` })
  const row = async (id: string) => (await db.select().from(assets).where(eq(assets.id, id)))[0]!

  it('registers a URL once and fetches nothing until it is asked for', async () => {
    const first = await remoteImage('https://images.example/cover-a.jpg', { kind: 'cover' })
    const second = await remoteImage('https://images.example/cover-a.jpg', { kind: 'cover' })
    expect(second.id).toBe(first.id)
    expect(first).toMatchObject({ status: 'remote', storagePath: null, color: null })
    expect(fetches).toEqual([])
    await expect(remoteImage('http://images.example/plain.jpg', { kind: 'cover' })).rejects.toMatchObject({ code: 'invalid_image' })
  })

  it('downloads on the first request, once, and serves from disk afterwards', async () => {
    const url = 'https://images.example/cover-b.jpg'
    served[url] = await picture('#2255aa')
    const asset = await remoteImage(url, { kind: 'cover' })

    const [one, two] = await Promise.all([art(asset.id), art(asset.id, 96)])
    expect(one.statusCode).toBe(200)
    expect(two.statusCode).toBe(200)
    expect(one.headers['content-type']).toBe('image/webp')
    expect(one.headers['cache-control']).toContain('immutable')
    expect((await sharp(one.rawPayload).metadata()).width).toBe(300)
    expect(fetches).toEqual([url])

    const stored = await row(asset.id)
    expect(stored).toMatchObject({ status: 'ready', mime: 'image/jpeg', width: 64, height: 64 })
    expect(stored.color).toMatch(/^#[0-9a-f]{6}$/)
    expect(stored.thumbhash).toBeTruthy()

    expect((await art(asset.id, 600)).statusCode).toBe(200)
    expect(fetches).toEqual([url])
  })

  it('keeps working when a remote image has the same bytes as a stored one', async () => {
    const bytes = await picture('#aa5522')
    const local = await storeImage(bytes, { kind: 'cover', source: 'test:local' })
    const url = 'https://images.example/same-bytes.jpg'
    served[url] = bytes
    const remote = await remoteImage(url, { kind: 'cover' })
    expect((await art(remote.id)).statusCode).toBe(200)
    expect((await row(remote.id)).sha256).toBe(local.sha256)
    expect((await art(local.id)).statusCode).toBe(200)
    // Storing the same bytes again still finds the local row, not the remote one.
    expect((await storeImage(bytes, { kind: 'cover', source: 'test:again' })).id).toBe(local.id)
  })

  it('answers 404 without caching when the image cannot be fetched, and retries later', async () => {
    const url = 'https://images.example/gone.jpg'
    const asset = await remoteImage(url, { kind: 'artist' })
    const missing = await art(asset.id)
    expect(missing.statusCode).toBe(404)
    expect(missing.headers['cache-control']).toBeUndefined()
    expect((await row(asset.id)).status).toBe('failed')

    // A second request soon after does not hit the provider again.
    expect((await art(asset.id)).statusCode).toBe(404)
    expect(fetches).toEqual([url])

    // Once the failure is old enough the next request tries again.
    served[url] = await picture('#11aa33')
    await db.update(assets).set({ checkedAt: new Date(Date.now() - 2 * 60 * 60 * 1000) }).where(eq(assets.id, asset.id))
    expect((await art(asset.id)).statusCode).toBe(200)
    expect(fetches).toEqual([url, url])
  })

  it('stops offering a cover the source does not have, but keeps one that failed for a while', async () => {
    const album = await createAlbum({ title: 'Only One' })
    const gone = await remoteImage('https://coverartarchive.org/release-group/97fd1d3f-30e3-40a1-96d8-98e002038092/front-500', { kind: 'cover' })
    await db.update(albums).set({ artworkAssetId: gone.id }).where(eq(albums.id, album.albumId))
    const artist = await createArtist({ name: 'Fcukers' })
    await db.update(artists).set({ imageAssetId: gone.id }).where(eq(artists.id, artist.id))

    expect((await art(gone.id)).statusCode).toBe(404)
    // A 404 means the source has no such image: summaries stop handing the id out.
    const [albumRow] = await db.select({ artworkAssetId: albums.artworkAssetId }).from(albums).where(eq(albums.id, album.albumId))
    expect(albumRow!.artworkAssetId).toBeNull()
    const [artistRow] = await db.select({ imageAssetId: artists.imageAssetId }).from(artists).where(eq(artists.id, artist.id))
    expect(artistRow!.imageAssetId).toBeNull()

    // A server error is an outage, not an answer: the cover stays and is tried again later.
    const flaky = await remoteImage('https://images.example/flaky.jpg', { kind: 'cover' })
    served['https://images.example/flaky.jpg'] = 502
    const other = await createAlbum({ title: 'Flaky' })
    await db.update(albums).set({ artworkAssetId: flaky.id }).where(eq(albums.id, other.albumId))
    expect((await art(flaky.id)).statusCode).toBe(404)
    const [kept] = await db.select({ artworkAssetId: albums.artworkAssetId }).from(albums).where(eq(albums.id, other.albumId))
    expect(kept!.artworkAssetId).toBe(flaky.id)
  })

  it('treats something that is not an image as a failure', async () => {
    const url = 'https://images.example/not-an-image.jpg'
    served[url] = Buffer.from('<html>blocked</html>')
    const asset = await remoteImage(url, { kind: 'cover' })
    expect((await art(asset.id)).statusCode).toBe(404)
    expect((await row(asset.id)).status).toBe('failed')
  })

  // metadata-and-privacy.md: turning a service off stops requests to it.
  it('downloads nothing from a source that has been turned off since the image was listed', async () => {
    const deezerCover = 'https://cdn-images.dzcdn.net/images/cover/abc/500x500.jpg'
    const caaCover = 'https://coverartarchive.org/release-group/1b022e01-4da6-387b-8658-8678046e4cef/front-500'
    const wikimediaPhoto = 'https://upload.wikimedia.org/wikipedia/commons/a/ab/Artist.jpg'
    const fanartPhoto = 'https://assets.fanart.tv/fanart/music/x/artistthumb/a.jpg'
    for (const url of [deezerCover, caaCover, wikimediaPhoto, fanartPhoto]) served[url] = await picture('#3366cc')
    const listed = await Promise.all([deezerCover, caaCover, wikimediaPhoto, fanartPhoto].map((url) => remoteImage(url, { kind: 'cover' })))

    // fanart.tv has no key in a fresh install, which is the same as off.
    await updateServerSettings({ deezerEnabled: false, coverArtArchiveEnabled: false, wikidataEnabled: false })
    for (const asset of listed) expect((await art(asset.id)).statusCode).toBe(404)
    expect(fetches).toEqual([])
    // Not a failed download: it is fetched as soon as the source is back on.
    expect((await row(listed[0]!.id)).status).toBe('remote')

    await updateServerSettings({ deezerEnabled: true, coverArtArchiveEnabled: true, wikidataEnabled: true })
    expect((await art(listed[0]!.id)).statusCode).toBe(200)
    expect(fetches).toEqual([deezerCover])
  })
})
