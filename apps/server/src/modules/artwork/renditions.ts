import { readFile } from 'node:fs/promises'
import { ART_SIZES, type ArtSize } from '@squirmy/contracts'
import { eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import sharp from 'sharp'
import { z } from 'zod'
import { db } from '../../database/client.js'
import { assets } from '../../database/schema.js'
import { notFound } from '../../lib/errors.js'
import { dataPath, writeAtomic } from './store.js'

const Params = z.object({
  assetId: z.uuid(),
  size: z.coerce.number().pipe(z.union(ART_SIZES.map((size) => z.literal(size)))),
})

/** Renders in progress, so concurrent requests for one rendition share a single render. */
const rendering = new Map<string, Promise<Buffer>>()

/**
 * The square WebP rendition of an asset, cropped to fill. Rendered on first request and
 * kept under `<data>/art/<assetId>/<size>.webp`; that folder is safe to delete.
 */
export async function rendition(assetId: string, size: ArtSize): Promise<Buffer> {
  const file = dataPath('art', assetId, `${size}.webp`)
  const cached = await readFile(file).catch(() => null)
  if (cached) return cached
  const key = `${assetId}/${size}`
  let pending = rendering.get(key)
  if (!pending) {
    pending = render(assetId, size, file).finally(() => rendering.delete(key))
    rendering.set(key, pending)
  }
  return pending
}

async function render(assetId: string, size: ArtSize, file: string) {
  const [asset] = await db.select({ storagePath: assets.storagePath }).from(assets).where(eq(assets.id, assetId))
  if (!asset) throw notFound('No such artwork')
  const original = await readFile(dataPath(asset.storagePath)).catch(() => {
    throw notFound('The artwork file is missing')
  })
  const output = await sharp(original).autoOrient().resize(size, size, { fit: 'cover' }).webp({ quality: 82 }).toBuffer()
  await writeAtomic(file, output)
  return output
}

export async function artworkRoutes(app: FastifyInstance) {
  // Unauthenticated on purpose: ids are unguessable and the bytes never change, so
  // <img> tags, AVPlayer and Subsonic clients can load art without credentials.
  app.get('/art/:assetId/:size', async (request, reply) => {
    const parsed = Params.safeParse(request.params)
    if (!parsed.success) throw notFound('No such artwork')
    const { assetId, size } = parsed.data
    const etag = `"${assetId}-${size}"`
    reply.header('cache-control', 'public, max-age=31536000, immutable').header('etag', etag)
    if (request.headers['if-none-match'] === etag) return reply.code(304).send()
    const image = await rendition(assetId, size)
    return reply.type('image/webp').send(image)
  })
}
