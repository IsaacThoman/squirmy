import { assets, mediaFiles, plays } from '../database/schema.js'
import { db } from '../database/client.js'
import { newId, newPublicId } from '../lib/ids.js'

/** Rows the catalog and userdata tests need beyond `factories.ts`. */

export async function createAsset(color = '#112233') {
  const [row] = await db.insert(assets).values({
    id: newPublicId(), kind: 'cover', source: 'test', sha256: newId(), mime: 'image/webp', width: 1, height: 1, bytes: 1,
    color, thumbhash: 'AAAA', storagePath: 'test',
  }).returning()
  return row!
}

/** Records a play that started `minutesAgo` minutes ago. */
export async function createPlay(input: { userId: string; recordingId: string; albumId?: string | null; minutesAgo?: number; completed?: boolean }) {
  const [row] = await db.insert(plays).values({
    id: newId(),
    userId: input.userId,
    recordingId: input.recordingId,
    albumId: input.albumId ?? null,
    startedAt: new Date(Date.now() - (input.minutesAgo ?? 0) * 60_000),
    msPlayed: 60_000,
    completed: input.completed ?? true,
  }).returning()
  return row!
}

/** Links a new present file to a recording, which makes the recording owned. */
export async function createFile(input: { rootId: string; recordingId: string; albumId?: string | null; addedAt?: Date; source?: string }) {
  const id = newId()
  await db.insert(mediaFiles).values({
    id,
    rootId: input.rootId,
    relPath: `extra/${id}.flac`,
    size: 1_000_000,
    mtime: new Date(),
    container: 'flac',
    codec: 'flac',
    lossless: true,
    durationMs: 180_000,
    recordingId: input.recordingId,
    albumId: input.albumId ?? null,
    probeStage: 1,
    addedAt: input.addedAt,
    source: input.source,
  })
  return id
}
