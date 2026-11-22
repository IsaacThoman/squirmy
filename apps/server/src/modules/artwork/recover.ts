/**
 * Lost originals. A stored image lives under `<data>/assets/`; when that file is gone
 * (deleted, or the data folder restored from an older backup) the image is rebuilt from
 * where it came from:
 * - pictures embedded in music files: read again from the file it was taken from, or any
 *   present file whose embedded picture it is;
 * - folder images (`folder:<path>`): read again;
 * - images from a URL: downloaded again. A remote image (`remote_url`) takes what the URL
 *   serves now, as its first download did.
 * Everything but a remote image must come back byte for byte (the same SHA-256), so an
 * asset id never starts showing a different picture.
 *
 * Disk sources are read while the request waits. A download runs as `artwork.recover` and
 * the request answers 404 meanwhile. An asset nothing can rebuild is marked `missing` and
 * answers 404 at once; `artwork.sweep` (daily) finds lost files before anyone asks, notices
 * files that came back, and tries `missing` assets again after a week, so nothing retries
 * in a loop.
 */
import { createHash } from 'node:crypto'
import { access, readFile } from 'node:fs/promises'
import path from 'node:path'
import { parseFile } from 'music-metadata'
import { and, asc, eq, gt, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm'
import { db } from '../../database/client.js'
import { assets, libraryRoots, mediaFiles } from '../../database/schema.js'
import { enqueue, enqueueMany } from '../../jobs/index.js'
import { notFound } from '../../lib/errors.js'
import { fetchImage } from '../metadata/index.js'
import { dataPath, ensureStored, writeAtomic, type Asset, type StoredAsset } from './store.js'

export type RecoverJob = { assetId: string }

/** Below tag reading, like other background work. */
const SWEEP_PRIORITY = -10
/** A `missing` asset is tried again after this long. */
const retryMissingAfterMs = 7 * 24 * 60 * 60 * 1000
const sweepPage = 1000
/** Files read per asset when looking for an embedded picture. */
const fileCandidates = 5

const exists = (file: string) => access(file).then(() => true, () => false)
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

/** The URL an asset can be downloaded from again, if it has one. */
function sourceUrl(asset: Asset): string | null {
  return asset.remoteUrl ?? (/^https:\/\//i.test(asset.source) ? asset.source : null)
}

/** Readers of the bytes the asset might have come from on disk, most likely first. */
async function diskSources(asset: Asset): Promise<(() => Promise<Uint8Array[]>)[]> {
  const sources: (() => Promise<Uint8Array[]>)[] = []
  if (asset.source.startsWith('folder:')) {
    const file = asset.source.slice('folder:'.length)
    sources.push(async () => [await readFile(file)])
  }
  // The same bytes are stored once, so a folder or downloaded cover can also be the picture embedded in some file.
  const sourceFileId = /^file:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(asset.source)?.[1]
  const files = await db.select({ rootPath: libraryRoots.path, relPath: mediaFiles.relPath }).from(mediaFiles)
    .innerJoin(libraryRoots, eq(libraryRoots.id, mediaFiles.rootId))
    .where(and(isNull(mediaFiles.missingSince), or(eq(mediaFiles.embeddedArtAssetId, asset.id), sourceFileId ? eq(mediaFiles.id, sourceFileId) : undefined)))
    .orderBy(sql`${mediaFiles.id} = ${sourceFileId ?? null} desc nulls last`)
    .limit(fileCandidates)
  for (const file of files) {
    sources.push(async () => {
      const { common } = await parseFile(path.join(file.rootPath, file.relPath))
      return (common.picture ?? []).map((picture) => picture.data)
    })
  }
  return sources
}

/** Writes the original back from a disk source with the same bytes. Returns them, or null. */
async function recoverFromDisk(asset: StoredAsset): Promise<Buffer | null> {
  for (const read of await diskSources(asset)) {
    const candidates = await read().catch(() => [])
    const match = candidates.find((bytes) => sha256(bytes) === asset.sha256)
    if (match) return restore(asset, Buffer.from(match))
  }
  return null
}

async function restore(asset: StoredAsset, bytes: Buffer): Promise<Buffer> {
  await writeAtomic(dataPath(asset.storagePath), bytes)
  if (asset.status !== 'ready') await db.update(assets).set({ status: 'ready', checkedAt: new Date() }).where(eq(assets.id, asset.id))
  return bytes
}

async function markMissing(assetId: string) {
  await db.update(assets).set({ status: 'missing', checkedAt: new Date() }).where(eq(assets.id, assetId))
}

/**
 * The bytes of an asset's original, downloading a remote image the first time. A lost
 * file is rebuilt from disk while the caller waits, or queued for download. Throws
 * `not_found` when there is no image now.
 */
export async function readOriginal(assetId: string): Promise<{ asset: StoredAsset; bytes: Buffer }> {
  const asset = await ensureStored(assetId)
  const bytes = await readFile(dataPath(asset.storagePath)).catch(() => null) ?? await recoverFromDisk(asset)
  if (bytes) return { asset, bytes }
  if (sourceUrl(asset)) await enqueue<RecoverJob>('artwork.recover', { assetId }, { singletonKey: assetId })
  else await markMissing(assetId)
  throw notFound('The artwork file is missing')
}

/**
 * `artwork.recover`: makes a stored asset's file whole again, or marks the asset
 * `missing`. Does nothing for an asset whose file is there, except to clear `missing`.
 */
export async function recoverAsset({ assetId }: RecoverJob): Promise<void> {
  const [row] = await db.select().from(assets).where(eq(assets.id, assetId))
  if (!row?.storagePath || !row.sha256 || (row.status !== 'ready' && row.status !== 'missing')) return
  const asset = row as StoredAsset
  if (await exists(dataPath(asset.storagePath))) {
    if (asset.status === 'missing') await db.update(assets).set({ status: 'ready', checkedAt: new Date() }).where(eq(assets.id, assetId))
    return
  }
  if (await recoverFromDisk(asset)) return
  if (asset.remoteUrl) {
    // Forget the lost bytes: the next request downloads it as it did the first time, and a
    // failure waits an hour like any failed download.
    await db.update(assets).set({ status: 'remote' }).where(eq(assets.id, assetId))
    await ensureStored(assetId).catch(() => null)
    return
  }
  const url = sourceUrl(asset)
  const image = url ? await fetchImage(url).catch(() => null) : null
  if (image && sha256(image.bytes) === asset.sha256) await restore(asset, image.bytes)
  else await markMissing(assetId)
}

/**
 * `artwork.sweep`: queues `artwork.recover` for every stored asset whose file is gone, every
 * `missing` asset whose file is back, and every `missing` asset last tried a week ago.
 */
export async function sweepArtwork(): Promise<void> {
  let after: string | undefined
  for (;;) {
    const rows = await db.select({ id: assets.id, storagePath: assets.storagePath, status: assets.status, checkedAt: assets.checkedAt }).from(assets)
      .where(and(isNotNull(assets.storagePath), inArray(assets.status, ['ready', 'missing']), after ? gt(assets.id, after) : undefined))
      .orderBy(asc(assets.id))
      .limit(sweepPage)
    if (rows.length === 0) return
    const due = await Promise.all(rows.map(async (row) => {
      const present = await exists(dataPath(row.storagePath!))
      if (row.status === 'ready') return !present
      return present || !row.checkedAt || Date.now() - row.checkedAt.getTime() >= retryMissingAfterMs
    }))
    await enqueueMany<RecoverJob>('artwork.recover', rows.filter((_, index) => due[index])
      .map((row) => ({ data: { assetId: row.id }, singletonKey: row.id, priority: SWEEP_PRIORITY })))
    after = rows.at(-1)!.id
  }
}
