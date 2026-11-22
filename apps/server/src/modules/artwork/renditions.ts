import { readFile } from 'node:fs/promises'
import { ART_SIZES, type ArtSize } from '@squirmy/contracts'
import type { FastifyInstance } from 'fastify'
import sharp from 'sharp'
import { z } from 'zod'
import { etagMatches } from '../../lib/conditional.js'
import { notFound } from '../../lib/errors.js'
import { readOriginal } from './recover.js'
import { dataPath, writeAtomic } from './store.js'

const Params = z.object({
  assetId: z.uuid(),
  size: z.coerce.number().pipe(z.union(ART_SIZES.map((size) => z.literal(size)))),
})

/** Renders in progress, so concurrent requests for one rendition share a single render. */
const rendering = new Map<string, Promise<Buffer>>()

/**
 * The square WebP rendition of an asset, cropped to fill. Rendered on first request and
 * kept under `<data>/art/<assetId>/<size>.webp`; that folder is safe to delete. A remote
 * image is downloaded first, and a lost original is rebuilt (see `recover.ts`).
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
  const { bytes: original } = await readOriginal(assetId)
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
    const cacheForever = 'public, max-age=31536000, immutable'
    if (etagMatches(request.headers['if-none-match'], etag)) return reply.code(304).header('cache-control', cacheForever).header('etag', etag).send()
    // Only a rendered image is cacheable; a failed remote fetch may succeed later.
    const image = await rendition(assetId, size)
    return reply.header('cache-control', cacheForever).header('etag', etag).type('image/webp').send(image)
  })
}
