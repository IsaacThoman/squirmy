import type { TrackCredit, TrackWork } from '@squirmy/contracts'
import { sql } from 'drizzle-orm'
import { db } from '../../database/client.js'
import { uuidArray } from './sql.js'

export async function trackCredits(ids: string[]): Promise<Map<string, TrackCredit[]>> {
  if (!ids.length) return new Map()
  const requested = uuidArray(ids)
  const rows = await db.execute<{
    recordingId: string; artistId: string; name: string; role: TrackCredit['role']; instrument: string
  }>(sql`
    select distinct c.recording_id as "recordingId", a.id as "artistId", a.name, c.role, c.instrument
    from (
      select rc.recording_id, rc.artist_id, rc.role, rc.instrument
      from recording_credits rc where rc.recording_id = any(${requested})
      union all
      select f.recording_id, rc.artist_id, rc.role, rc.instrument
      from media_files f join recording_credits rc on rc.file_id = f.id
      where f.recording_id = any(${requested}) and f.missing_since is null
    ) c join artists a on a.id = c.artist_id
    order by c.role, a.name, c.instrument, a.id`)
  const result = new Map<string, TrackCredit[]>()
  for (const { recordingId, artistId, name, role, instrument } of rows) {
    const credits = result.get(recordingId) ?? []
    credits.push({ artist: { id: artistId, name }, role, ...(instrument ? { instrument } : {}) })
    result.set(recordingId, credits)
  }
  return result
}

export async function trackWorks(ids: string[]): Promise<Map<string, TrackWork[]>> {
  if (!ids.length) return new Map()
  const requested = uuidArray(ids)
  const rows = await db.execute<{
    recordingId: string; id: string; mbid: string | null; title: string
    movementName: string | null; movementNumber: number | null; movementTotal: number | null
  }>(sql`
    with tagged as (
      select distinct on (f.recording_id) f.recording_id, rw.work_id, rw.movement_name, rw.movement_number, rw.movement_total
      from media_files f join recording_works rw on rw.file_id = f.id
      where f.recording_id = any(${requested}) and f.missing_since is null
      order by f.recording_id, f.cached, f.added_at, f.id
    )
    select x.recording_id as "recordingId", w.id, w.mbid, w.title,
      x.movement_name as "movementName", x.movement_number as "movementNumber", x.movement_total as "movementTotal"
    from (
      select * from tagged
      union all
      select rw.recording_id, rw.work_id, rw.movement_name, rw.movement_number, rw.movement_total
      from recording_works rw where rw.recording_id = any(${requested})
        and not exists (select 1 from tagged where tagged.recording_id = rw.recording_id)
    ) x join works w on w.id = x.work_id
    order by w.title, w.id`)
  const result = new Map<string, TrackWork[]>()
  for (const { recordingId, id, mbid, title, movementName, movementNumber, movementTotal } of rows) {
    const links = result.get(recordingId) ?? []
    links.push({ id, mbid, title, movementName: movementName ?? undefined, movementNumber: movementNumber ?? undefined, movementTotal: movementTotal ?? undefined })
    result.set(recordingId, links)
  }
  return result
}

/** An owned recording's advisory follows its files. The catalog flag is the fallback. */
export const trackExplicit = (recordingId: ReturnType<typeof sql>, fallback: ReturnType<typeof sql>, albumId: ReturnType<typeof sql>) => sql`
  coalesce((
    select (f.tags ->> 'explicit')::boolean from media_files f
    where f.recording_id = ${recordingId} and f.missing_since is null and f.tags ? 'explicit'
    order by (f.album_id = ${albumId}) is true desc, f.cached, f.added_at, f.id limit 1
  ), ${fallback})`
