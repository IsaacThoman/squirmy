import { sql } from 'drizzle-orm'
import { db } from '../../database/client.js'
import { enqueueMany } from '../../jobs/index.js'
import { getServerSettings } from '../../lib/settings.js'
import { uuidArray } from '../catalog/sql.js'
import { ANALYSIS_VERSION, type AnalyzeJob, type DeezerTempoJob } from './analyze.js'

/**
 * Below every other job of the queue: on-demand requests (a radio seed nobody analysed
 * yet) go first. The queue has a single worker slot, so analysis never takes more than
 * one core, whatever the backlog.
 */
export const ANALYZE_PRIORITY = -30
/** Files queued per sweep, oldest first. Finished files drop out, so each sweep moves on. */
const SWEEP_BATCH = 300
const DEEZER_BATCH = 100
/** Deezer is asked again about a recording it gave no tempo for after this long. */
const DEEZER_RECHECK = '90 days'

/**
 * Queues a batch of present files that need sonic work: never seen (their tempo, key and
 * mood tags are read even with analysis off), or (with analysis on) not analysed by this
 * version of the analysis or analysed before their audio changed. Files wait for their
 * loudness, so the heavier work of the two follows the one playback needs.
 *
 * Then, with Deezer on, queues Deezer's tempo for owned recordings nothing else gives
 * one: no tempo tag, no analysed tempo, and no analysis still to come.
 */
export async function sweepSonic(): Promise<void> {
  const settings = await getServerSettings()
  const enabled = settings.sonicAnalysisEnabled
  const files = await db.execute<{ id: string }>(sql`
    select f.id from media_files f left join sonic_analyses s on s.file_id = f.id
    where f.missing_since is null and f.probe_stage >= 2 and f.loudness_lufs is not null
      and (s.file_id is null or (${enabled} and (s.version is distinct from ${ANALYSIS_VERSION} or s.audio_hash is distinct from f.audio_hash)))
    order by f.added_at, f.id
    limit ${SWEEP_BATCH}`)
  await enqueueMany<AnalyzeJob>('sonic.analyze', files.map((file) => ({ data: { fileId: file.id }, singletonKey: file.id, priority: ANALYZE_PRIORITY })))

  if (!settings.deezerEnabled) return
  const recordings = await db.execute<DeezerTempoJob>(sql`
    select owned.id as "recordingId", min(e.external_id) as "deezerId"
    from (select distinct recording_id as id from media_files where missing_since is null and recording_id is not null) owned
    join recordings r on r.id = owned.id and r.merged_into_id is null
    join external_ids e on e.entity_type = 'recording' and e.entity_id = owned.id and e.provider = 'deezer'
    left join sonic_hints h on h.recording_id = owned.id
    where (h.deezer_checked_at is null or h.deezer_checked_at < now() - ${DEEZER_RECHECK}::interval)
      and not exists (
        select 1 from media_files f left join sonic_analyses s on s.file_id = f.id
        where f.recording_id = owned.id and f.missing_since is null
          and (f.tags ? 'bpm' or (s.bpm is not null and s.error is null)
            or (${enabled} and (s.file_id is null or s.version is distinct from ${ANALYSIS_VERSION}))))
    group by owned.id
    limit ${DEEZER_BATCH}`)
  await enqueueMany<DeezerTempoJob>('sonic.deezer-tempo', recordings.map((data) => ({ data, singletonKey: data.recordingId })))
}

/**
 * Queues analysis of the recordings' present files that lack it, ahead of the background
 * backlog: something someone asked for now (a sonic radio's seed). Nothing with analysis off.
 */
export async function analyzeSoon(recordingIds: readonly string[]): Promise<void> {
  if (recordingIds.length === 0 || !(await getServerSettings()).sonicAnalysisEnabled) return
  const files = await db.execute<{ id: string }>(sql`
    select f.id from media_files f left join sonic_analyses s on s.file_id = f.id
    where f.recording_id = any(${uuidArray(recordingIds)}) and f.missing_since is null and f.probe_stage >= 2
      and (s.file_id is null or s.version is distinct from ${ANALYSIS_VERSION} or s.audio_hash is distinct from f.audio_hash)`)
  await enqueueMany<AnalyzeJob>('sonic.analyze', files.map((file) => ({ data: { fileId: file.id }, singletonKey: file.id, priority: 0 })))
}
