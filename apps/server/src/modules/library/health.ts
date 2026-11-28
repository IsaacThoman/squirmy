import { realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import { type HealthPage, type HealthStatus } from '@squirmy/contracts'
import { and, asc, desc, eq, gt, isNotNull, isNull, or, sql } from 'drizzle-orm'
import { db } from '../../database/client.js'
import { withSessionLock } from '../../database/locks.js'
import { albums, libraryRoots, mediaFiles, recordings } from '../../database/schema.js'
import { enqueue } from '../../jobs/index.js'
import { notFound } from '../../lib/errors.js'
import { audioInput, readAudioHash, runFfmpeg } from '../../lib/ffmpeg.js'
import { getServerSettings } from '../../lib/settings.js'
import { collectionFile, describeFile, fileJoins, hygieneColumns } from './hygiene-files.js'

const pageSize = 50
const jobName = 'library.check-health'
const checked = sql`coalesce(${mediaFiles.healthCheckedAt}, '-infinity'::timestamptz)`

export async function listFileHealth(cursor?: string, issues = false): Promise<HealthPage> {
  const rows = await db.select(hygieneColumns).from(mediaFiles)
    .innerJoin(libraryRoots, fileJoins.root).leftJoin(albums, fileJoins.album).leftJoin(recordings, fileJoins.recording)
    .where(and(collectionFile, cursor ? gt(mediaFiles.id, cursor) : undefined,
      issues ? sql`${mediaFiles.healthStatus} <> 'healthy'` : undefined))
    .orderBy(mediaFiles.id).limit(pageSize + 1)
  return {
    items: rows.slice(0, pageSize).map(row => ({
      ...describeFile(row), status: row.file.healthStatus, detail: row.file.healthDetail,
      checkedAt: row.file.healthCheckedAt?.toISOString() ?? null, pending: row.file.healthRequestedAt !== null,
    })),
    nextCursor: rows.length > pageSize ? rows[pageSize - 1]!.file.id : null,
  }
}

export async function requestHealthCheck(id: string) {
  const [row] = await db.update(mediaFiles).set({ healthRequestedAt: new Date() })
    .where(and(eq(mediaFiles.id, id), collectionFile)).returning({ id: mediaFiles.id })
  if (!row) throw notFound('No such library file')
  await enqueue(jobName, {}, { singletonKey: jobName, priority: -20 })
}

type HealthResult = { status: HealthStatus; detail: string | null }

/** Decodes every audio stream and hashes the first stream's original packets in the same pass. */
export async function inspectAudio(file: string, expectedHash: string | null): Promise<HealthResult> {
  try {
    const { stdout, stderr } = await runFfmpeg([
      '-xerror', '-err_detect', 'explode+crccheck', '-threads', '1', '-readrate', '8',
      ...audioInput(file), '-map', '0:a', '-threads', '1', '-f', 'null', '-',
      '-map', '0:a:0', '-c', 'copy', '-f', 'hash', '-hash', 'sha256', '-',
    ], { timeoutMs: 18 * 60_000, maxBuffer: 64 * 1024, lowPriority: true })
    if (stderr.trim()) return { status: 'decode_error', detail: stderr.trim().slice(0, 500) }
    const hash = readAudioHash(stdout, file)
    if (!expectedHash) return { status: 'no_hash', detail: 'Audio decoded successfully. No scan hash is available for comparison.' }
    if (expectedHash !== hash) return { status: 'hash_changed', detail: 'The audio stream differs from the hash recorded by the library.' }
    return { status: 'healthy', detail: null }
  } catch (error) {
    const failure = error as Error & { killed?: boolean; code?: string | number; stderr?: string }
    if (failure.killed || typeof failure.code === 'string') {
      return { status: 'unavailable', detail: failure.killed ? 'The decode exceeded the time or output limit.' : 'Unable to start the audio decoder.' }
    }
    return { status: 'decode_error', detail: failure.stderr?.trim().slice(0, 500) || 'The audio decoder could not read the stream.' }
  }
}

async function inspectOnDisk(root: string, relPath: string, hash: string | null): Promise<HealthResult | null> {
  const original = path.resolve(root, relPath)
  const [base, file] = await Promise.all([realpath(root).catch(() => null), realpath(original).catch(() => null)])
  const relative = base && file ? path.relative(base, file) : ''
  if (!file || !relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
    return { status: 'unavailable', detail: 'The file is inaccessible or points outside its library folder.' }
  }
  const before = await stat(file).catch(() => null)
  if (!before?.isFile()) return { status: 'unavailable', detail: 'The audio file is inaccessible.' }
  const result = await inspectAudio(file, hash)
  const after = await stat(file).catch(() => null)
  if (!after || before.ino !== after.ino || before.dev !== after.dev || before.size !== after.size || before.mtimeMs !== after.mtimeMs) return null
  return result
}

/**
 * A check is checkpointed per file. The next tick resumes with the oldest unchecked file.
 * A session lock keeps concurrent workers and manual requests to one decoder across the server.
 */
export async function scrubFiles() {
  await withSessionLock('squirmy.library:file-health', async () => {
    const { fileHealthIntervalDays } = await getServerSettings()
    const cutoff = new Date(Date.now() - fileHealthIntervalDays * 86_400_000)
    const until = Date.now() + 45_000
    const rows = await db.select({ file: mediaFiles, root: libraryRoots.path }).from(mediaFiles)
      .innerJoin(libraryRoots, fileJoins.root)
      .where(and(collectionFile, or(isNotNull(mediaFiles.healthRequestedAt), fileHealthIntervalDays > 0
        ? and(eq(libraryRoots.enabled, true), sql`${checked} < ${cutoff.toISOString()}::timestamptz`)
        : undefined)))
      .orderBy(desc(isNotNull(mediaFiles.healthRequestedAt)), asc(mediaFiles.healthRequestedAt), asc(checked), mediaFiles.id)
      .limit(50)
    for (const { file, root } of rows) {
      if (Date.now() >= until) break
      const result = await inspectOnDisk(root, file.relPath, file.audioHash)
      if (!result) continue
      await db.update(mediaFiles).set({
        healthStatus: result.status, healthDetail: result.detail, healthCheckedAt: new Date(),
        healthRequestedAt: sql`case when ${mediaFiles.healthRequestedAt} is not distinct from
          ${file.healthRequestedAt?.toISOString() ?? null}::timestamptz then null else ${mediaFiles.healthRequestedAt} end`,
      }).where(and(eq(mediaFiles.id, file.id), eq(mediaFiles.rootId, file.rootId), eq(mediaFiles.relPath, file.relPath),
        eq(mediaFiles.mtime, file.mtime), eq(mediaFiles.size, file.size), isNull(mediaFiles.missingSince),
        file.audioHash ? eq(mediaFiles.audioHash, file.audioHash) : isNull(mediaFiles.audioHash)))
    }
  })
}

export async function kickHealthCheck() {
  await enqueue(jobName, {}, { singletonKey: jobName, priority: -20 })
}
