import { createHash, randomBytes } from 'node:crypto'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { and, eq, isNull } from 'drizzle-orm'
import sharp, { type Metadata } from 'sharp'
import { rgbaToThumbHash } from 'thumbhash'
import { getConfig } from '../../config.js'
import { db } from '../../database/client.js'
import { albums, assets } from '../../database/schema.js'
import { AppError } from '../../lib/errors.js'
import { newPublicId } from '../../lib/ids.js'

export type Asset = typeof assets.$inferSelect

/** cover: album art. artist: an artist photo. embedded: a picture inside an audio file. */
export type AssetKind = 'cover' | 'artist' | 'embedded'

const maxBytes = 32 * 1024 * 1024
const minSide = 16
const maxSide = 12_000
const extensions: Record<string, string> = { jpeg: 'jpg', png: 'png', webp: 'webp', gif: 'gif', avif: 'avif', tiff: 'tiff' }
const mimes: Record<string, string> = { jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', avif: 'image/avif', tiff: 'image/tiff' }

/** Absolute path under the data directory. */
export function dataPath(...parts: string[]) {
  return path.resolve(getConfig().SQUIRMY_DATA_DIR, ...parts)
}

/** Writes through a temporary file so readers never see a partial file. */
export async function writeAtomic(file: string, data: Uint8Array) {
  await mkdir(path.dirname(file), { recursive: true })
  const temporary = `${file}.${randomBytes(6).toString('hex')}.tmp`
  await writeFile(temporary, data)
  await rename(temporary, file)
}

const invalidImage = (message: string) => new AppError(422, 'invalid_image', message)

/**
 * Stores an image and returns its `assets` row. The same bytes always give the same row:
 * images are de-duplicated by SHA-256 before anything is decoded.
 *
 * Throws `invalid_image` for anything that is not a JPEG, PNG, WebP, GIF, AVIF or TIFF
 * between 16 and 12000 pixels a side and at most 32 MiB.
 */
export async function storeImage(bytes: Uint8Array, { kind, source }: { kind: AssetKind; source: string }): Promise<Asset> {
  if (bytes.byteLength === 0 || bytes.byteLength > maxBytes) throw invalidImage('The image is empty or too large')
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  const [existing] = await db.select().from(assets).where(eq(assets.sha256, sha256))
  if (existing) return existing

  let metadata: Metadata
  let analysis: { color: string; thumbhash: string }
  try {
    metadata = await sharp(bytes, { limitInputPixels: maxSide * maxSide }).metadata()
    if (!metadata.format || !extensions[metadata.format]) throw invalidImage(`Unsupported image format: ${metadata.format ?? 'unknown'}`)
    const { width = 0, height = 0 } = metadata
    if (Math.min(width, height) < minSide || Math.max(width, height) > maxSide) throw invalidImage(`Image size ${width}x${height} is out of range`)
    analysis = await analyze(bytes)
  } catch (error) {
    if (error instanceof AppError) throw error
    throw invalidImage(`The image cannot be decoded: ${(error as Error).message}`)
  }

  const storagePath = path.posix.join('assets', sha256.slice(0, 2), sha256.slice(2, 4), `${sha256}.${extensions[metadata.format]}`)
  await writeAtomic(dataPath(storagePath), bytes)
  const [inserted] = await db.insert(assets).values({
    id: newPublicId(),
    kind,
    source,
    sha256,
    mime: mimes[metadata.format]!,
    width: metadata.autoOrient.width,
    height: metadata.autoOrient.height,
    bytes: bytes.byteLength,
    color: analysis.color,
    thumbhash: analysis.thumbhash,
    storagePath,
  }).onConflictDoNothing({ target: assets.sha256 }).returning()
  if (inserted) return inserted
  // Another job stored the same image a moment ago.
  const [winner] = await db.select().from(assets).where(eq(assets.sha256, sha256))
  return winner!
}

/** Decodes a small copy once for both the placeholder and the color. */
async function analyze(bytes: Uint8Array) {
  const { data, info } = await sharp(bytes)
    .autoOrient()
    .resize(100, 100, { fit: 'inside' })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })
  return {
    color: dominantColor(data),
    thumbhash: Buffer.from(rgbaToThumbHash(info.width, info.height, data)).toString('base64'),
  }
}

/**
 * The color an album page can be tinted with, as #rrggbb. Pixels are bucketed by color;
 * buckets that are neither near-black nor near-white win, weighted towards saturated
 * colors. A mostly black or white cover still gets black or white when nothing else
 * covers a meaningful share of it.
 */
export function dominantColor(rgba: Uint8Array): string {
  const buckets = new Map<number, { count: number; r: number; g: number; b: number }>()
  let pixels = 0
  for (let index = 0; index < rgba.length; index += 4) {
    if (rgba[index + 3]! < 128) continue
    const r = rgba[index]!
    const g = rgba[index + 1]!
    const b = rgba[index + 2]!
    const key = ((r >> 5) << 6) | ((g >> 5) << 3) | (b >> 5)
    const bucket = buckets.get(key) ?? { count: 0, r: 0, g: 0, b: 0 }
    bucket.count += 1
    bucket.r += r
    bucket.g += g
    bucket.b += b
    buckets.set(key, bucket)
    pixels += 1
  }
  if (pixels === 0) return '#000000'

  let best: { score: number; rgb: number[] } | undefined
  let common: { count: number; rgb: number[] } | undefined
  let pleasantPixels = 0
  for (const bucket of buckets.values()) {
    const rgb = [bucket.r / bucket.count, bucket.g / bucket.count, bucket.b / bucket.count]
    if (!common || bucket.count > common.count) common = { count: bucket.count, rgb }
    const max = Math.max(...rgb) / 255
    const min = Math.min(...rgb) / 255
    const lightness = (max + min) / 2
    if (lightness < 0.12 || lightness > 0.9) continue
    const saturation = max === min ? 0 : (max - min) / (1 - Math.abs(2 * lightness - 1))
    pleasantPixels += bucket.count
    const score = bucket.count * (0.4 + saturation)
    if (!best || score > best.score) best = { score, rgb }
  }
  const pick = best && pleasantPixels / pixels >= 0.05 ? best.rgb : common!.rgb
  return `#${pick.map((channel) => Math.round(channel).toString(16).padStart(2, '0')).join('')}`
}

/**
 * Points an album at an artwork asset. With `onlyIfEmpty`, an album that already has
 * artwork keeps it. Returns whether the album changed. Callers invalidate the album's
 * query keys.
 */
export async function assignAlbumArtwork(albumId: string, assetId: string, { onlyIfEmpty }: { onlyIfEmpty: boolean }): Promise<boolean> {
  const updated = await db.update(albums)
    .set({ artworkAssetId: assetId, updatedAt: new Date() })
    .where(and(eq(albums.id, albumId), onlyIfEmpty ? isNull(albums.artworkAssetId) : undefined))
    .returning({ id: albums.id })
  return updated.length > 0
}
