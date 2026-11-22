import { access, readFile } from 'node:fs/promises'
import { ART_SIZES, type ArtSize } from '@squirmy/contracts'
import type { FastifyInstance } from 'fastify'
import sharp from 'sharp'
import { z } from 'zod'
import { eq } from 'drizzle-orm'
import { db } from '../../database/client.js'
import { assets } from '../../database/schema.js'
import { etagMatches } from '../../lib/conditional.js'
import { notFound } from '../../lib/errors.js'
import { readOriginal } from './recover.js'
import { dataPath, writeAtomic } from './store.js'

const Params = z.object({
  assetId: z.uuid(),
  // `300` or `300.webp`. The extension lets a CDN in front keep renditions at the edge
  // (Cloudflare caches by file extension); the web app asks with it.
  size: z.string().regex(/^\d+(\.webp)?$/).transform((size) => Number.parseInt(size, 10))
    .pipe(z.union(ART_SIZES.map((size) => z.literal(size)))),
})

/** The sizes grids and lists ask for, rendered as soon as an image is stored (`artwork.render`). */
export const PRERENDERED_SIZES: readonly ArtSize[] = [96, 300, 600]

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

export type RenderJob = { assetId: string }

/**
 * `artwork.render`: writes the common renditions of a newly stored image, so the first
 * grid that shows it reads files instead of waiting on a resize per cover. The original is
 * read once for all sizes; sizes already on disk are skipped.
 */
export async function prerender({ assetId }: RenderJob) {
  const [asset] = await db.select({ status: assets.status, storagePath: assets.storagePath }).from(assets).where(eq(assets.id, assetId))
  if (asset?.status !== 'ready' || !asset.storagePath) return
  let original: Buffer | undefined
  for (const size of PRERENDERED_SIZES) {
    const file = dataPath('art', assetId, `${size}.webp`)
    if (await access(file).then(() => true, () => false)) continue
    // Only what is on disk: rebuilding a lost original (and marking it missing when that
    // fails) is for a request to decide, not a head start.
    original ??= await readFile(dataPath(asset.storagePath)).catch(() => undefined)
    if (!original) return
    await render(assetId, size, file, original)
  }
}

async function render(assetId: string, size: ArtSize, file: string, original?: Buffer) {
  original ??= (await readOriginal(assetId)).bytes
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
