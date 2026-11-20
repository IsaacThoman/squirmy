import { createHash, randomBytes } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { onTestFinished } from 'vitest'
import { db } from '../../database/client.js'
import { fileMoves, libraryRoots, mediaFiles, type FileTags, type MatchStatus } from '../../database/schema.js'
import { newId } from '../../lib/ids.js'
import { makeTone } from '../../test/audio.js'
import { createAlbum, createLibraryRoot, type AlbumFactoryInput } from '../../test/factories.js'

/** Test helpers: real files in a temp root, with library rows pointing at them. */

/** Call inside a test: the folder is removed when the test finishes. */
export async function makeRoot(mode: 'managed' | 'read_only' = 'managed', template?: string) {
  const dir = await mkdtemp(path.join(tmpdir(), 'squirmy-organize-'))
  onTestFinished(() => rm(dir, { recursive: true, force: true }))
  const root = await createLibraryRoot({ path: dir, mode, name: path.basename(dir) })
  if (template) await db.update(libraryRoots).set({ template }).where(eq(libraryRoots.id, root.id))
  return { ...root, path: dir }
}

/** Writes a file with random bytes (or a quiet tone when `audio` is set) under the root. */
export async function writeFixture(root: string, relPath: string, audio = false): Promise<string> {
  const absolute = path.join(root, relPath)
  await mkdir(path.dirname(absolute), { recursive: true })
  if (audio) await makeTone(root, { path: relPath, durationSec: 1 })
  else await writeFile(absolute, randomBytes(2048 + Math.floor(Math.random() * 2048)))
  return absolute
}

type Link = { albumId: string; releaseId: string; recordingId: string; releaseTrackId: string }

/** Inserts a `media_files` row for a file already on disk, with its real size and mtime. */
export async function addFileRow(rootId: string, rootPath: string, relPath: string, input: {
  link?: Link | null
  matchStatus?: MatchStatus
  matchLocked?: boolean
  tags?: FileTags
  missing?: boolean
  audioHash?: string | null
} = {}) {
  const stats = await stat(path.join(rootPath, relPath)).catch(() => null)
  const id = newId()
  await db.insert(mediaFiles).values({
    id,
    rootId,
    relPath,
    size: stats?.size ?? 0,
    mtime: stats?.mtime ?? new Date(),
    container: path.extname(relPath).slice(1),
    codec: path.extname(relPath).slice(1),
    durationMs: 1000,
    tags: input.tags ?? {},
    audioHash: input.audioHash ?? null,
    recordingId: input.link?.recordingId ?? null,
    releaseTrackId: input.link?.releaseTrackId ?? null,
    releaseId: input.link?.releaseId ?? null,
    albumId: input.link?.albumId ?? null,
    matchStatus: input.matchStatus ?? (input.link ? 'matched' : 'unmatched'),
    matchLocked: input.matchLocked ?? false,
    missingSince: input.missing ? new Date() : null,
    probeStage: 2,
  })
  return id
}

/**
 * Creates a catalog album and, for each track, a file at `paths[i]` linked to it.
 * Returns the album and the file ids in track order.
 */
export async function addAlbum(root: { id: string; path: string }, album: AlbumFactoryInput, paths: string[], options: { audio?: boolean; matchStatus?: MatchStatus; tags?: FileTags } = {}) {
  const created = await createAlbum(album)
  const fileIds: string[] = []
  for (const [index, track] of created.tracks.entries()) {
    const relPath = paths[index]
    if (!relPath) continue
    await writeFixture(root.path, relPath, options.audio)
    fileIds.push(await addFileRow(root.id, root.path, relPath, {
      link: { albumId: created.albumId, releaseId: created.releaseId, recordingId: track.recordingId, releaseTrackId: track.releaseTrackId },
      matchStatus: options.matchStatus ?? 'matched',
      tags: options.tags,
    }))
  }
  return { ...created, fileIds }
}

/** Every file (with its SHA-256) and every directory under a root, for before/after comparisons. */
export async function manifest(root: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  const walk = async (dir: string) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const absolute = path.join(dir, entry.name)
      const rel = path.relative(root, absolute).split(path.sep).join('/')
      if (entry.isDirectory()) {
        out[`${rel}/`] = 'dir'
        await walk(absolute)
      } else {
        out[rel] = createHash('sha256').update(await readFile(absolute)).digest('hex')
      }
    }
  }
  await walk(root)
  return out
}

export async function movesOf(batchId: string) {
  return db.select().from(fileMoves).where(eq(fileMoves.batchId, batchId)).orderBy(fileMoves.id)
}

export async function relPathOf(fileId: string) {
  const [row] = await db.select({ relPath: mediaFiles.relPath }).from(mediaFiles).where(eq(mediaFiles.id, fileId))
  return row?.relPath
}
