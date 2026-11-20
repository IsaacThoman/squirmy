import { readdir } from 'node:fs/promises'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import sharp from 'sharp'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { buildApp } from '../../app.js'
import { getConfig } from '../../config.js'
import { db } from '../../database/client.js'
import { albums, assets } from '../../database/schema.js'
import { createAlbum } from '../../test/factories.js'
import { useTestDatabase } from '../../test/database.js'
import { assignAlbumArtwork, dominantColor, storeImage } from './store.js'

// Count renders: they are the sharp calls that read a stored original.
const renders = vi.hoisted(() => ({ count: 0 }))
vi.mock('sharp', async (importOriginal) => {
  const actual = (await importOriginal<{ default: typeof sharp }>()).default
  const wrapped = (...args: Parameters<typeof sharp>) => {
    const instance = actual(...args)
    const resize = instance.resize.bind(instance) as (width: number, height: number, options?: object) => typeof instance
    instance.resize = ((width: number, height: number, options?: object) => {
      if (width === height && width !== 100) renders.count += 1
      return resize(width, height, options)
    }) as typeof instance.resize
    return instance
  }
  return { default: Object.assign(wrapped, actual) }
})

const image = (color: string, width = 64, height = width, format: 'png' | 'jpeg' = 'png') =>
  sharp({ create: { width, height, channels: 3, background: color } })[format]().toBuffer()

describe('artwork', () => {
  useTestDatabase()
  let app: FastifyInstance

  beforeAll(async () => {
    app = await buildApp()
  })
  afterAll(async () => {
    await app.close()
  })

  it('stores an image once per content, with its color and placeholder', async () => {
    const bytes = await image('#336699', 120, 80, 'jpeg')
    const first = await storeImage(bytes, { kind: 'cover', source: 'test:a' })
    const second = await storeImage(Buffer.from(bytes), { kind: 'embedded', source: 'test:b' })
    expect(second.id).toBe(first.id)
    expect(first).toMatchObject({ kind: 'cover', mime: 'image/jpeg', width: 120, height: 80, bytes: bytes.length })
    expect(first.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(first.color).toMatch(/^#3[0-9a-f]6[0-9a-f]9[0-9a-f]$/)
    expect(Buffer.from(first.thumbhash!, 'base64').length).toBeGreaterThan(5)
    expect(first.storagePath).toBe(`assets/${first.sha256.slice(0, 2)}/${first.sha256.slice(2, 4)}/${first.sha256}.jpg`)
    const folder = path.join(getConfig().SQUIRMY_DATA_DIR, path.dirname(first.storagePath))
    expect(await readdir(folder)).toEqual([`${first.sha256}.jpg`])
    expect(await db.select().from(assets)).toHaveLength(1)
  })

  it('rejects things that are not reasonable images', async () => {
    await expect(storeImage(Buffer.from('not an image'), { kind: 'cover', source: 'x' })).rejects.toMatchObject({ code: 'invalid_image' })
    await expect(storeImage(Buffer.alloc(0), { kind: 'cover', source: 'x' })).rejects.toMatchObject({ code: 'invalid_image' })
    await expect(storeImage(await image('#000', 8), { kind: 'cover', source: 'x' })).rejects.toMatchObject({ code: 'invalid_image' })
    await expect(storeImage(await image('#000', 13_000, 20), { kind: 'cover', source: 'x' })).rejects.toMatchObject({ code: 'invalid_image' })
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64"/></svg>')
    await expect(storeImage(svg, { kind: 'cover', source: 'x' })).rejects.toMatchObject({ code: 'invalid_image' })
  })

  it('picks a pleasant dominant color', () => {
    const pixels = (parts: [number, [number, number, number]][]) => {
      const data: number[] = []
      for (const [count, rgb] of parts) for (let index = 0; index < count; index += 1) data.push(...rgb, 255)
      return Uint8Array.from(data)
    }
    // Mostly white with a red block: red wins over white.
    expect(dominantColor(pixels([[700, [255, 255, 255]], [300, [200, 30, 40]]]))).toBe('#c81e28')
    // Mostly black with a little blue: blue wins over black.
    expect(dominantColor(pixels([[800, [5, 5, 5]], [200, [40, 80, 200]]]))).toBe('#2850c8')
    // Nothing else to choose: black stays black.
    expect(dominantColor(pixels([[990, [0, 0, 0]], [10, [250, 250, 250]]]))).toBe('#000000')
  })

  it('serves square WebP renditions with immutable caching', async () => {
    const asset = await storeImage(await image('#c46a2b', 640, 480), { kind: 'cover', source: 'test:c' })
    const response = await app.inject({ url: `/api/v1/art/${asset.id}/300` })
    expect(response.statusCode).toBe(200)
    expect(response.headers['content-type']).toBe('image/webp')
    expect(response.headers['cache-control']).toBe('public, max-age=31536000, immutable')
    const etag = response.headers.etag as string
    expect(etag).toBe(`"${asset.id}-300"`)
    expect(await sharp(response.rawPayload).metadata()).toMatchObject({ format: 'webp', width: 300, height: 300 })
    const big = await app.inject({ url: `/api/v1/art/${asset.id}/1200` })
    expect(await sharp(big.rawPayload).metadata()).toMatchObject({ width: 1200, height: 1200 })

    const cached = await app.inject({ url: `/api/v1/art/${asset.id}/300`, headers: { 'if-none-match': etag } })
    expect(cached.statusCode).toBe(304)
    expect(cached.headers['cache-control']).toBe('public, max-age=31536000, immutable')
    expect((await app.inject({ url: `/api/v1/art/${asset.id}/123` })).statusCode).toBe(404)
    expect((await app.inject({ url: '/api/v1/art/00000000-0000-4000-8000-000000000000/300' })).statusCode).toBe(404)
    expect((await app.inject({ url: '/api/v1/art/not-an-id/300' })).statusCode).toBe(404)
  })

  it('renders a rendition once for concurrent requests', async () => {
    const asset = await storeImage(await image('#2b6ac4', 500), { kind: 'cover', source: 'test:d' })
    const before = renders.count
    const responses = await Promise.all(Array.from({ length: 6 }, () => app.inject({ url: `/api/v1/art/${asset.id}/600` })))
    expect(responses.map((response) => response.statusCode)).toEqual([200, 200, 200, 200, 200, 200])
    expect(new Set(responses.map((response) => response.rawPayload.length)).size).toBe(1)
    expect(renders.count - before).toBe(1)
    await app.inject({ url: `/api/v1/art/${asset.id}/600` })
    expect(renders.count - before).toBe(1)
  })

  it('assigns album artwork, optionally only when there is none', async () => {
    const { albumId } = await createAlbum()
    const first = await storeImage(await image('#111111'), { kind: 'cover', source: 'test:e' })
    const second = await storeImage(await image('#222222'), { kind: 'cover', source: 'test:f' })
    expect(await assignAlbumArtwork(albumId, first.id, { onlyIfEmpty: true })).toBe(true)
    expect(await assignAlbumArtwork(albumId, second.id, { onlyIfEmpty: true })).toBe(false)
    expect((await db.select().from(albums).where(eq(albums.id, albumId)))[0]!.artworkAssetId).toBe(first.id)
    expect(await assignAlbumArtwork(albumId, second.id, { onlyIfEmpty: false })).toBe(true)
    expect((await db.select().from(albums).where(eq(albums.id, albumId)))[0]!.artworkAssetId).toBe(second.id)
  })
})
