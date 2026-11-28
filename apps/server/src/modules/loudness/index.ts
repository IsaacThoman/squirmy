import { and, asc, gte, isNull, or, sql } from 'drizzle-orm'
import { db } from '../../database/client.js'
import { mediaFiles } from '../../database/schema.js'
import { enqueue, enqueueAtPriority, schedule } from '../../jobs/index.js'
import type { ServerModule } from '../types.js'
import { LOUDNESS_ERROR_PREFIX, measureFile, measureRelease } from './measure.js'

type MeasureJob = { fileId: string }
type AlbumJob = { releaseId: string }

/** Sweep jobs yield to on-demand work within the same queue. */
const MEASURE_PRIORITY = -20
const PLAY_PRIORITY = 20
const ALBUM_PRIORITY = -10
/** Files queued per sweep. Measured files drop out, so each sweep moves the window on. */
const SWEEP_BATCH = 500
const MEASURE_RETRIES = 2

type MeasurementState = Pick<typeof mediaFiles.$inferSelect,
  'id' | 'loudnessLufs' | 'decodedFrames' | 'decodedRate' | 'probeError' | 'probeStage' | 'missingSince'>

export async function measureOnPlay(file: MeasurementState): Promise<void> {
  if (file.probeStage < 1 || file.probeError || file.missingSince
    || (file.loudnessLufs !== null && file.decodedFrames !== null && file.decodedRate !== null)) return
  await enqueueAtPriority<MeasureJob>('loudness.measure', { fileId: file.id }, file.id, PLAY_PRIORITY)
}

function enqueueAlbum(releaseId: string) {
  return enqueue<AlbumJob>('loudness.album', { releaseId }, { singletonKey: releaseId, priority: ALBUM_PRIORITY })
}

/**
 * Queues a bounded batch of present, probed files without loudness or lengths, and every release
 * whose album loudness is missing or stale: its file count changed, a file changed after
 * it was computed, or no file is left.
 */
export async function sweepLoudness() {
  const files = await db.select({ id: mediaFiles.id }).from(mediaFiles)
    .where(and(
      or(isNull(mediaFiles.loudnessLufs), isNull(mediaFiles.decodedFrames), isNull(mediaFiles.decodedRate)),
      isNull(mediaFiles.probeError), isNull(mediaFiles.missingSince), gte(mediaFiles.probeStage, 1),
    ))
    .orderBy(asc(mediaFiles.addedAt))
    .limit(SWEEP_BATCH)
  for (const { id } of files) {
    await enqueue<MeasureJob>('loudness.measure', { fileId: id }, { singletonKey: id, priority: MEASURE_PRIORITY })
  }

  const releases = await db.execute<{ release_id: string }>(sql`
    select f.release_id from media_files f
    left join release_loudness rl on rl.release_id = f.release_id
    where f.release_id is not null and f.missing_since is null
    group by f.release_id, rl.release_id, rl.file_count, rl.computed_at
    having (bool_and(f.loudness_lufs is not null and f.true_peak_db is not null)
      and (rl.release_id is null or rl.file_count <> count(*) or max(f.updated_at) > rl.computed_at))
      or (rl.release_id is not null and bool_or(starts_with(f.probe_error, ${LOUDNESS_ERROR_PREFIX})))
    union all
    select rl.release_id from release_loudness rl
    where not exists (select 1 from media_files f where f.release_id = rl.release_id and f.missing_since is null)
    limit ${SWEEP_BATCH}`)
  for (const row of releases) await enqueueAlbum(row.release_id)
}

export const loudnessModule: ServerModule = {
  name: 'loudness',
  async jobs(jobs) {
    jobs.define<MeasureJob>('loudness.measure', { concurrency: 1, retryLimit: MEASURE_RETRIES }, async ({ fileId }, { attempt }) => {
      const releaseId = await measureFile(fileId, attempt > MEASURE_RETRIES)
      if (releaseId) await enqueueAlbum(releaseId)
    })
    jobs.define<AlbumJob>('loudness.album', { concurrency: 1, timeoutSeconds: 60 * 60 }, async ({ releaseId }) => {
      await measureRelease(releaseId)
    })
    jobs.define('loudness.sweep', {}, sweepLoudness)
    await schedule('loudness.sweep', '*/10 * * * *')
  },
  async start({ role }) {
    if (role !== 'api') await enqueue('loudness.sweep', {}, { singletonKey: 'sweep' })
  },
}
