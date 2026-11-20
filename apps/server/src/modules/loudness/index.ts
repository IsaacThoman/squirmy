import { and, asc, gte, isNull, sql } from 'drizzle-orm'
import { db } from '../../database/client.js'
import { mediaFiles } from '../../database/schema.js'
import { enqueue, schedule } from '../../jobs/index.js'
import type { ServerModule } from '../types.js'
import { measureFile, measureRelease } from './measure.js'

type MeasureJob = { fileId: string }
type AlbumJob = { releaseId: string }

/** Loudness work runs below everything else; measurement is the lowest of all. */
const MEASURE_PRIORITY = -20
const ALBUM_PRIORITY = -10
/** Files queued per sweep. Measured files drop out, so each sweep moves the window on. */
const SWEEP_BATCH = 500
const MEASURE_RETRIES = 2

function enqueueMeasure(fileId: string) {
  return enqueue<MeasureJob>('loudness.measure', { fileId }, { singletonKey: fileId, priority: MEASURE_PRIORITY })
}

function enqueueAlbum(releaseId: string) {
  return enqueue<AlbumJob>('loudness.album', { releaseId }, { singletonKey: releaseId, priority: ALBUM_PRIORITY })
}

/**
 * Queues a bounded batch of present, probed files without loudness, and every release
 * whose album loudness is missing or stale: its file count changed, a file changed after
 * it was computed, or no file is left.
 */
export async function sweepLoudness() {
  const files = await db.select({ id: mediaFiles.id }).from(mediaFiles)
    .where(and(isNull(mediaFiles.loudnessLufs), isNull(mediaFiles.missingSince), gte(mediaFiles.probeStage, 1)))
    .orderBy(asc(mediaFiles.addedAt))
    .limit(SWEEP_BATCH)
  for (const file of files) await enqueueMeasure(file.id)

  const releases = await db.execute<{ release_id: string }>(sql`
    select f.release_id from media_files f
    left join release_loudness rl on rl.release_id = f.release_id
    where f.release_id is not null and f.missing_since is null
    group by f.release_id, rl.release_id, rl.file_count, rl.computed_at
    having bool_and(f.loudness_lufs is not null)
      and (rl.release_id is null or rl.file_count <> count(*) or max(f.updated_at) > rl.computed_at)
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
