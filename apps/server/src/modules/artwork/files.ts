import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { and, eq, inArray, isNull } from 'drizzle-orm'
import { db } from '../../database/client.js'
import { albums, artists, assets } from '../../database/schema.js'
import { matchKey } from '../../lib/text.js'
import { assignAlbumArtwork, storeImage, type Asset } from './store.js'

/** A picture embedded in an audio file, as music-metadata reports it. */
export type EmbeddedPicture = { data: Uint8Array; type?: string }

const imageExtension = /\.(jpe?g|png|webp)$/i
// Earlier names win when a folder holds several.
const coverNames = [/^cover$/i, /^front$/i, /^folder$/i, /^album$/i, /^albumart.*$/i]
const artistNames = [/^artist$/i, /^folder$/i]

/** The front cover when the file labels one, otherwise the first picture. */
export function pickEmbeddedPicture(pictures: readonly EmbeddedPicture[] | undefined): EmbeddedPicture | undefined {
  return pictures?.find((picture) => picture.type === 'Cover (front)') ?? pictures?.[0]
}

/** Stores the picture embedded in a file. Unreadable images are ignored. */
export async function storeEmbeddedPicture(fileId: string, picture: EmbeddedPicture): Promise<Asset | null> {
  return storeImage(picture.data, { kind: 'embedded', source: `file:${fileId}` }).catch(() => null)
}

/** Image files in `directory` whose name matches one of `names`, best match first. */
async function findImages(directory: string, names: RegExp[]) {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
  const found: { file: string; rank: number }[] = []
  for (const entry of entries) {
    if (!entry.isFile() || !imageExtension.test(entry.name)) continue
    const rank = names.findIndex((name) => name.test(entry.name.replace(imageExtension, '')))
    if (rank >= 0) found.push({ file: path.join(directory, entry.name), rank })
  }
  return found.sort((a, b) => a.rank - b.rank || a.file.localeCompare(b.file)).map((image) => image.file)
}

async function storeFolderImage(file: string, kind: 'cover' | 'artist') {
  const bytes = await readFile(file).catch(() => null)
  return bytes ? storeImage(bytes, { kind, source: `folder:${file}` }).catch(() => null) : null
}

/**
 * Gives an album without artwork the largest of its folder image (cover.jpg, folder.jpg…,
 * looked for in each of `directories`) and its files' embedded pictures. Returns whether
 * the album changed.
 */
export async function albumArtFromFiles(albumId: string, directories: readonly string[], embeddedAssetIds: readonly string[]): Promise<boolean> {
  const [album] = await db.select({ artworkAssetId: albums.artworkAssetId }).from(albums).where(eq(albums.id, albumId))
  if (!album || album.artworkAssetId) return false

  const candidates: Pick<Asset, 'id' | 'width' | 'height'>[] = []
  for (const directory of new Set(directories)) {
    const [image] = await findImages(directory, coverNames)
    const asset = image ? await storeFolderImage(image, 'cover') : null
    if (asset) candidates.push(asset)
  }
  if (embeddedAssetIds.length > 0) {
    candidates.push(...await db.select({ id: assets.id, width: assets.width, height: assets.height }).from(assets)
      .where(inArray(assets.id, [...new Set(embeddedAssetIds)])))
  }
  // Folder images come first, so they win ties.
  const area = (asset: (typeof candidates)[number]) => (asset.width ?? 0) * (asset.height ?? 0)
  const best = candidates.reduce<(typeof candidates)[number] | undefined>(
    (current, candidate) => (!current || area(candidate) > area(current) ? candidate : current), undefined)
  return best ? assignAlbumArtwork(albumId, best.id, { onlyIfEmpty: true }) : false
}

/**
 * Gives an artist without an image the `artist.jpg` or `folder.jpg` in `directory`, but
 * only when the folder is named after the artist. Returns whether the artist changed.
 */
export async function artistImageFromFolder(artistId: string, directory: string): Promise<boolean> {
  const [artist] = await db.select({ nameKey: artists.nameKey, imageAssetId: artists.imageAssetId }).from(artists).where(eq(artists.id, artistId))
  if (!artist || artist.imageAssetId || matchKey(path.basename(directory)) !== artist.nameKey) return false
  const [image] = await findImages(directory, artistNames)
  const asset = image ? await storeFolderImage(image, 'artist') : null
  if (!asset) return false
  const updated = await db.update(artists).set({ imageAssetId: asset.id, updatedAt: new Date() })
    .where(and(eq(artists.id, artistId), isNull(artists.imageAssetId)))
    .returning({ id: artists.id })
  return updated.length > 0
}
