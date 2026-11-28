import { createHash } from 'node:crypto'
import { mkdir, readdir, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import {
  HISTORY_IMPORT_MAX_BYTES, Id, queryKeys, type HistoryImport, type HistoryImportSource, type HistoryImports,
} from '@squirmy/contracts'
import { and, desc, eq, inArray, sql } from 'drizzle-orm'
import type { FastifyRequest } from 'fastify'
import { getConfig } from '../../config.js'
import { db, type Transaction } from '../../database/client.js'
import { withSessionLock } from '../../database/locks.js'
import { historyImportedPlays, historyImports, plays } from '../../database/schema.js'
import { enqueue, findJob, type JobContext } from '../../jobs/index.js'
import { AppError, badRequest } from '../../lib/errors.js'
import { newId } from '../../lib/ids.js'
import { creditKey, matchKey } from '../../lib/text.js'
import { invalidate } from '../../realtime/index.js'
import { requireRoomFor } from '../imports/space.js'
import { TooLargeError, writeLimited } from '../imports/staging.js'
import { isCompleted } from '../sessions/plays.js'
import { HistoryFormatError, readListens, type ImportedListen } from './history-formats.js'

export const HISTORY_IMPORT_QUEUE = 'userdata.history-import'
export const HISTORY_IMPORT_RETRIES = 3
const BATCH_SIZE = 500
const ABANDONED_AFTER_MS = 24 * 60 * 60_000

function directory() {
  return path.resolve(getConfig().SQUIRMY_DATA_DIR, 'history-imports')
}

function summary({ userId: _user, jsonLines: _lines, createdAt, ...row }: typeof historyImports.$inferSelect): HistoryImport {
  return { ...row, createdAt: createdAt.toISOString() }
}

export async function listHistoryImports(userId: string): Promise<HistoryImports> {
  const rows = await db.select().from(historyImports).where(eq(historyImports.userId, userId)).orderBy(desc(historyImports.createdAt)).limit(10)
  return { items: rows.map(summary) }
}

export async function uploadHistory(userId: string, source: HistoryImportSource, request: FastifyRequest): Promise<HistoryImport> {
  if (!request.isMultipart()) throw badRequest('Send a history file as multipart/form-data', 'not_multipart')
  const limit = HISTORY_IMPORT_MAX_BYTES
  const root = directory()
  await requireRoomFor(root, limit)
  await mkdir(root, { recursive: true, mode: 0o700 })
  const id = newId()
  const file = path.join(root, id)
  let bytes = 0
  let jsonLines = false
  try {
    for await (const part of request.parts({ limits: { fileSize: limit + 1, files: 1, fields: 0, parts: 2 } })) {
      if (part.type !== 'file' || part.fieldname !== 'file') throw badRequest('Choose one history file', 'invalid_history_upload')
      jsonLines = source === 'listenbrainz' && /\.(jsonl|listens|ndjson)$/i.test(part.filename)
      bytes = await writeLimited(part.file, file, limit)
    }
    if (!bytes) throw badRequest('Choose a non-empty history file', 'invalid_history_upload')
    return await db.transaction(async tx => {
      const [row] = await tx.insert(historyImports).values({ id, userId, source, jsonLines }).returning()
      await enqueue(HISTORY_IMPORT_QUEUE, { id }, { tx, singletonKey: id, priority: -10 })
      return summary(row!)
    })
  } catch (error) {
    await rm(file, { force: true })
    if (error instanceof TooLargeError) throw new AppError(413, 'history_file_too_large', 'History files can be up to 128 MB')
    throw error
  }
}

type Input = typeof historyImportedPlays.$inferInsert

function importRow(job: typeof historyImports.$inferSelect, listen: ImportedListen): Input {
  const { startedAt, title, artist, album, msPlayed, sourceTrack } = listen
  const trackKey = creditKey(artist, title)
  const fingerprint = createHash('sha256').update(JSON.stringify([startedAt.toISOString(), sourceTrack ?? trackKey])).digest('hex')
  return {
    id: newId(), userId: job.userId, source: job.source, fingerprint, startedAt, title, artist, album, msPlayed,
    skipped: msPlayed !== null && msPlayed < 5000,
    trackKey, artistKey: matchKey(artist), albumKey: album ? creditKey(artist, album) : null,
  }
}

type Matched = { id: string; recordingId: string; albumId: string | null; durationMs: number | null }

/**
 * The album tag disambiguates recordings when it matches a known placement. Other
 * ties stay private until a user can tell which recording they meant.
 */
async function matchBatch(tx: Transaction, ids: string[]): Promise<Matched[]> {
  if (!ids.length) return []
  const rows = await tx.execute<Matched>(sql`
    select p.id, best.recording_id as "recordingId", best.album_id as "albumId", best.duration_ms as "durationMs"
    from history_imported_plays p
    cross join lateral (
      select r.id as recording_id, placement.album_id, r.duration_ms,
        count(*) over (partition by coalesce(placement.exact, false)) as ties
      from recordings r
      left join lateral (
        select a.id as album_id, coalesce(a.title_key = split_part(p.album_key, '|', 2), false) as exact
        from (
          select f.album_id, 0 as priority
          from media_files f where f.recording_id = r.id and f.missing_since is null
          union all
          select rl.album_id, 1 from release_tracks rt join releases rl on rl.id = rt.release_id where rt.recording_id = r.id
          union all
          select coalesce(hint.merged_into_id, hint.id), 2 from albums hint where hint.id = r.album_hint_id
        ) options join albums a on a.id = options.album_id
        where a.merged_into_id is null
          and (p.album_key is null or a.title_key = split_part(p.album_key, '|', 2))
        order by options.priority, (a.primary_artist_id = r.primary_artist_id) desc nulls last,
          (a.type = 'album') desc, a.year nulls last, a.id
        limit 1
      ) placement on true
      where r.merged_into_id is null and r.match_key = p.track_key
      order by placement.exact desc nulls last, r.id
      limit 1
    ) best
    where p.id in ${ids} and best.ties = 1`)
  return [...rows]
}

async function saveBatch(job: typeof historyImports.$inferSelect, listens: (ImportedListen | null)[], offset: number) {
  const values = listens.flatMap(listen => listen ? [importRow(job, listen)] : [])
  const ignored = listens.length - values.length
  await db.transaction(async tx => {
    const [checkpoint] = await tx.select({ processed: historyImports.processed }).from(historyImports)
      .where(eq(historyImports.id, job.id)).for('update')
    if (!checkpoint || checkpoint.processed !== offset) throw new Error('History import checkpoint changed')
    const kept = values.length ? await tx.insert(historyImportedPlays).values(values).onConflictDoNothing().returning() : []
    const matches = await matchBatch(tx, kept.map(row => row.id))
    if (matches.length) {
      const byId = new Map(kept.map(row => [row.id, row]))
      await tx.insert(plays).values(matches.map(match => {
        const row = byId.get(match.id)!
        const duration = match.durationMs ?? 0
        const msPlayed = row.msPlayed ?? duration
        return {
          id: row.id, userId: job.userId, recordingId: match.recordingId, albumId: match.albumId, client: 'history-import',
          startedAt: row.startedAt, msPlayed, skipped: row.skipped,
          completed: !row.skipped && (row.msPlayed === null || isCompleted(msPlayed, duration)),
        }
      }))
      await tx.update(historyImportedPlays).set({ playId: historyImportedPlays.id })
        .where(inArray(historyImportedPlays.id, matches.map(match => match.id)))
    }
    await tx.update(historyImports).set({
      processed: offset + listens.length,
      matched: sql`${historyImports.matched} + ${matches.length}`,
      unmatched: sql`${historyImports.unmatched} + ${kept.length - matches.length}`,
      duplicates: sql`${historyImports.duplicates} + ${values.length - kept.length}`,
      ignored: sql`${historyImports.ignored} + ${ignored}`,
    }).where(eq(historyImports.id, job.id))
  })
}

export async function processHistoryImport({ id }: { id: string }, { attempt }: JobContext): Promise<void> {
  const lock = await withSessionLock(`history-import:${id}`, async () => {
    const file = path.join(directory(), id)
    const [job] = await db.update(historyImports).set({ status: 'running' })
      .where(and(eq(historyImports.id, id), inArray(historyImports.status, ['queued', 'running']))).returning()
    if (!job) {
      await rm(file, { force: true })
      return
    }
    let status: HistoryImport['status'] = 'completed'
    let message: string | null = null
    try {
      let read = 0
      let offset = job.processed
      let batch: (ImportedListen | null)[] = []
      for await (const listen of readListens(file, job.source, job.jsonLines)) {
        if (read++ < job.processed) continue
        batch.push(listen)
        if (batch.length === BATCH_SIZE) {
          await saveBatch(job, batch, offset)
          offset += batch.length
          batch = []
        }
      }
      if (batch.length) await saveBatch(job, batch, offset)
      if (read === 0) throw new HistoryFormatError('No listens were found in this file')
    } catch (error) {
      if (!(error instanceof HistoryFormatError) && (error as NodeJS.ErrnoException).code !== 'ENOENT' && attempt <= HISTORY_IMPORT_RETRIES) throw error
      status = 'failed'
      message = error instanceof HistoryFormatError ? error.message
        : (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'The uploaded file is missing' : 'The server could not finish this import'
    }
    await db.update(historyImports).set({ status, error: message }).where(eq(historyImports.id, job.id))
    await rm(file, { force: true })
    await invalidate({ user: job.userId }, [queryKeys.history(), queryKeys.home()])
    if (status === 'failed' && message === 'The server could not finish this import') throw new Error(message)
  })
  if (!lock.locked) throw new Error('Another worker is processing this history import')
}

/** Clean up interrupted uploads and jobs that expired before their handler could report failure. */
export async function sweepHistoryImports(now = Date.now()) {
  const root = directory()
  const names = await readdir(root).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return []
    throw error
  })
  for (const id of names.filter(name => Id.safeParse(name).success)) {
    const file = path.join(root, id)
    const info = await stat(file).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null
      throw error
    })
    if (!info?.isFile() || now - info.mtimeMs < ABANDONED_AFTER_MS) continue
    await withSessionLock(`history-import:${id}`, async () => {
      if (await findJob(HISTORY_IMPORT_QUEUE, id)) return
      await db.update(historyImports).set({ status: 'failed', error: 'The server could not finish this import' })
        .where(and(eq(historyImports.id, id), inArray(historyImports.status, ['queued', 'running'])))
      await rm(file, { force: true })
    })
  }
}
