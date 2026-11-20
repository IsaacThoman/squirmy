import { readdir, rmdir, stat, unlink } from 'node:fs/promises'
import path from 'node:path'
import { asc, eq } from 'drizzle-orm'
import { db } from '../../database/client.js'
import { transcodes } from '../../database/schema.js'
import { getServerSettings } from '../../lib/settings.js'
import { cacheRoot, isTranscoding } from './transcode.js'

/** Files and unfinished rows younger than this may belong to an encoder in another process. */
const GRACE_MS = 60 * 60_000

const exists = (file: string) => stat(file).then(() => true, () => false)

/**
 * The `streaming.evict` job. Drops rows whose file is gone and abandoned unfinished rows,
 * deletes least-recently-used transcodes until the cache fits `transcodeCacheMaxBytes`,
 * then deletes files no row points at and empty folders.
 */
export async function evictTranscodes() {
  const root = cacheRoot()
  const cutoff = Date.now() - GRACE_MS
  const rows = await db.select().from(transcodes).orderBy(asc(transcodes.lastUsedAt))
  const ready: typeof rows = []
  for (const row of rows) {
    if (row.status === 'ready') {
      if (await exists(path.join(root, row.storagePath))) ready.push(row)
      else await db.delete(transcodes).where(eq(transcodes.id, row.id))
    } else if (!isTranscoding(row.fileId, row.profile) && row.lastUsedAt.getTime() < cutoff) {
      await db.delete(transcodes).where(eq(transcodes.id, row.id))
    }
  }

  const { transcodeCacheMaxBytes } = await getServerSettings()
  let total = ready.reduce((sum, row) => sum + row.bytes, 0)
  while (total > transcodeCacheMaxBytes && ready.length > 0) {
    const row = ready.shift()!
    await db.delete(transcodes).where(eq(transcodes.id, row.id))
    await unlink(path.join(root, row.storagePath)).catch(() => {})
    total -= row.bytes
  }

  const known = new Set(ready.map((row) => path.join(root, row.storagePath)))
  for (const directory of await readdir(root, { withFileTypes: true }).catch(() => [])) {
    if (!directory.isDirectory()) continue
    const folder = path.join(root, directory.name)
    for (const name of await readdir(folder)) {
      const file = path.join(folder, name)
      if (known.has(file)) continue
      const info = await stat(file).catch(() => null)
      if (info && info.mtimeMs < cutoff) await unlink(file).catch(() => {})
    }
    // Fails while the folder still holds something, which is what we want.
    await rmdir(folder).catch(() => {})
  }
}
