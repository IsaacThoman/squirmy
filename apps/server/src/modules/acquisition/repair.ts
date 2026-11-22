/**
 * Looking again at deliveries that are not where they were asked for.
 *
 * - Deliveries made before delivered files were placed on their album at all (place.ts).
 *   Each fetched track was left on an album of its own built from its tags, so one album
 *   showed up once per track fetched, and the files stayed in `_Incoming` under review.
 * - Deliveries that waited for their album's track list when their import ended.
 * - Deliveries placed on a track list built from files, whose album has one from a source
 *   by now, or whose album's other row (MusicBrainz's, beside the search stub the request
 *   named) lists them.
 * - Deliveries of a request that named no album, for a track with no album hint (a popular
 *   track from an artist page): placement takes the album the file's tags name (place.ts).
 *
 * It runs the same placement as a new delivery, so the same rules decide: only files a
 * provider delivered for a finished job are looked at, a file goes on an album only as the
 * recording that job asked for (or as a track that is plainly the same recording), files
 * locked by "Fix match" and files the matcher identified itself are left alone, and an
 * album row is merged away only when it has no MusicBrainz id and no file left. Albums
 * built from a user's own files hold files that were not delivered, so they are never
 * emptied. The rows the files leave keep redirects, because their ids were visible for a
 * while. Whatever was placed is then filed by its import, and imports whose placed files
 * are still in `_Incoming` are filed (once a day at most, in case filing cannot succeed).
 *
 * `acquisition.repair` runs it over everything at worker start and once a day;
 * `acquisition.sweep` runs it over the last hours every minute. Running it again changes
 * nothing.
 */
import { INCOMING_FOLDER } from '@squirmy/contracts'
import { sql } from 'drizzle-orm'
import { getConfig } from '../../config.js'
import { db } from '../../database/client.js'
import { acquisitionJobs } from '../../database/schema.js'
import { enqueue } from '../../jobs/index.js'
import { refileImport } from '../imports/index.js'
import { placeDelivery } from './place.js'

export type RepairOptions = {
  /** Only deliveries of jobs that ended after this. */
  since?: Date
  /** Jobs looked at per run; the next run takes the rest. */
  limit?: number
  /** Stop starting on new jobs after this long. */
  budgetMs?: number
}

export type RepairResult = { jobs: number; placed: number; refiled: number }

function report(error: unknown) {
  if (getConfig().LOG_LEVEL !== 'silent') console.error('[acquisition]', error)
}

/** A release built from files: not from MusicBrainz, not fetched from any source. */
const fileBuilt = (alias: string) => sql.raw(`${alias}.mbid is null and ${alias}.fetched_at is null`)

/**
 * Finished jobs with a delivered file that is not placed, or is placed on a track list
 * built from files while its album has one from a source, or while another album lists its
 * recording from a source (the album's own row, when the file sat on a stub of it), newest
 * first.
 */
async function jobsToPlace(since: Date | undefined, before: string | null, limit: number) {
  return db.select().from(acquisitionJobs).where(sql`
    ${acquisitionJobs.status} = 'completed' and ${acquisitionJobs.importId} is not null
    ${since ? sql`and ${acquisitionJobs.completedAt} > ${since.toISOString()}` : sql``}
    ${before ? sql`and ${acquisitionJobs.id} < ${before}` : sql``}
    and exists (
      select 1 from imports i join media_files f on f.import_id = i.id
      where i.id = ${acquisitionJobs.importId} and i.kind = 'acquisition' and i.status = 'completed'
        and f.missing_since is null and f.recording_id is not null and f.match_locked = false and starts_with(f.source, 'provider:')
        and (
          (f.match_source is distinct from 'request' and f.match_status <> 'matched')
          or (f.match_source = 'request' and f.match_status = 'matched'
            and (f.release_track_id is null or exists (select 1 from releases held where held.id = f.release_id and ${fileBuilt('held')}))
            and exists (select 1 from releases better where better.album_id = f.album_id and not (${fileBuilt('better')})))
          or (f.match_source = 'request' and f.match_status = 'matched'
            and exists (select 1 from releases held where held.id = f.release_id and ${fileBuilt('held')})
            and exists (select 1 from albums stub where stub.id = f.album_id and stub.mbid is null)
            and exists (select 1 from release_tracks listed join releases elsewhere on elsewhere.id = listed.release_id
              where listed.recording_id = f.recording_id and elsewhere.album_id <> f.album_id and not (${fileBuilt('elsewhere')})))
        )
    )`).orderBy(sql`${acquisitionJobs.id} desc`).limit(limit)
}

/** Finished acquisition imports with an identified file still in their `_Incoming` folder, not filed again in the last day. */
async function importsToFile(since: Date | undefined, limit: number) {
  const rows = await db.execute<{ id: string }>(sql`
    select i.id from imports i
    where i.kind = 'acquisition' and i.status = 'completed'
      ${since ? sql`and i.completed_at > ${since.toISOString()}` : sql``}
      and coalesce((i.work->>'refiledAt')::timestamptz, '-infinity') < now() - interval '1 day'
      and exists (
        select 1 from media_files f
        where f.import_id = i.id and f.missing_since is null and f.match_status = 'matched' and f.release_track_id is not null
          and starts_with(f.rel_path, ${`${INCOMING_FOLDER}/`} || i.id::text || '/'))
    order by i.id desc limit ${limit}`)
  return rows.map((row) => row.id)
}

/**
 * Queues ingest (owned by the library module) for the groups of delivered files still on
 * rows built from their tags, so those rows are rewritten by today's grouping rules: an
 * album artist tag that ran a track's artists together made an artist of that name.
 */
async function reingestTagBuilt(limit: number) {
  // Only groups in a delivery's own `_Incoming/<importId>/` folder, which hold nothing else.
  const groups = await db.execute<{ rootId: string; groupKey: string }>(sql`
    select distinct f.root_id as "rootId", f.group_key as "groupKey" from media_files f join albums a on a.id = f.album_id
    join imports i on i.id = f.import_id and i.kind = 'acquisition' and i.status = 'completed'
    where f.missing_since is null and f.group_key is not null and f.match_locked = false and f.match_status <> 'matched'
      and starts_with(f.source, 'provider:') and starts_with(f.rel_path, ${`${INCOMING_FOLDER}/`} || i.id::text || '/')
      and a.mbid is null and a.detail_level > 0
      and exists (select 1 from album_artists aa join artists ar on ar.id = aa.artist_id where aa.album_id = a.id and ar.mbid is null and ar.name like '%,%')
    limit ${limit}`)
  for (const group of groups) await enqueue('library.ingest', group, { singletonKey: group.groupKey })
}

/**
 * Jobs this process looked at and could not place, by id, with when: they are skipped for a
 * while so a run every minute does not redo them and older jobs get their turn. Kept in
 * memory: a restart runs the full repair anyway.
 */
const triedAt = new Map<string, number>()
const RETRY_MS = 5 * 60_000

/** Forgets which jobs were tried, for tests. */
export function resetRepair() {
  triedAt.clear()
}

/** Places and files what the module comment lists. Failures of one job are reported and the rest go on. */
export async function repairDeliveries(options: RepairOptions = {}): Promise<RepairResult> {
  const limit = options.limit ?? 500
  const deadline = Date.now() + (options.budgetMs ?? 10 * 60_000)
  const result: RepairResult = { jobs: 0, placed: 0, refiled: 0 }
  const filed = new Set<string>()
  for (const [id, at] of triedAt) if (at < Date.now() - RETRY_MS) triedAt.delete(id)
  // Newest first, page by page, until the budget or the limit runs out.
  let before: string | null = null
  pages: while (result.jobs < limit && Date.now() <= deadline) {
    const page = await jobsToPlace(options.since, before, 100)
    if (page.length === 0) break
    before = page.at(-1)!.id
    for (const job of page) {
      if (Date.now() > deadline || result.jobs >= limit) break pages
      if (triedAt.has(job.id)) continue
      result.jobs += 1
      try {
        const { placed } = await placeDelivery(job, { redirect: true, again: true })
        result.placed += placed.length
        if (placed.length === 0) {
          triedAt.set(job.id, Date.now())
          continue
        }
        filed.add(job.importId!)
        await refileImport(job.importId!)
        result.refiled += 1
      } catch (error) {
        triedAt.set(job.id, Date.now())
        report(error)
      }
    }
  }
  for (const importId of await importsToFile(options.since, limit)) {
    if (Date.now() > deadline) break
    if (filed.has(importId)) continue
    try {
      await refileImport(importId)
      result.refiled += 1
    } catch (error) {
      report(error)
    }
  }
  if (!options.since) await reingestTagBuilt(limit).catch(report)
  return result
}
