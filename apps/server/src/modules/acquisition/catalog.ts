/** The catalog facts acquisition needs: ownership after merges, and an album's track list. */
import { sql } from 'drizzle-orm'
import { db } from '../../database/client.js'
import { canonicalRelease, recordingOwned } from '../catalog/availability.js'
import { resolveMerged } from '../catalog/redirects.js'
import { uuidArray } from '../catalog/sql.js'

/** Of the given recording ids, those whose recording (after merges) has a present file. */
export async function ownedRecordings(ids: readonly string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set()
  const resolved = await resolveMerged('recordings', ids)
  const targets = [...new Set(resolved.values())]
  if (targets.length === 0) return new Set()
  const rows = await db.execute<{ id: string }>(sql`
    select distinct recording_id as id from media_files where recording_id = any(${uuidArray(targets)}) and missing_since is null`)
  const owned = new Set(rows.map((row) => row.id))
  return new Set(ids.filter((id) => owned.has(resolved.get(id) ?? '')))
}

export type AlbumInfo = { id: string; title: string; artist: string; mbid: string | null; year: number | null; barcode: string | null }
export type AlbumTrack = {
  recordingId: string; disc: number; position: number; title: string; durationMs: number | null
  mbid: string | null; isrcs: string[]; owned: boolean
}

/** An album (already redirect-resolved) and the tracks of the release that stands for it. Null when it does not exist. */
export async function albumWithTracks(albumId: string): Promise<{ album: AlbumInfo; tracks: AlbumTrack[] } | null> {
  const [album] = await db.execute<AlbumInfo & { releaseId: string | null }>(sql`
    select a.id, a.title, a.artist_credit as artist, a.mbid, a.year, rel.barcode, rel.id as "releaseId"
    from albums a left join releases rel on rel.id = ${canonicalRelease('a')}
    where a.id = ${albumId}`)
  if (!album) return null
  const tracks = album.releaseId ? await db.execute<AlbumTrack>(sql`
    select rt.recording_id as "recordingId", rt.disc, rt.position, rt.title, coalesce(rt.duration_ms, r.duration_ms) as "durationMs",
      r.mbid, r.isrcs, ${recordingOwned('rt.recording_id')} as owned
    from release_tracks rt join recordings r on r.id = rt.recording_id
    where rt.release_id = ${album.releaseId}
    order by rt.disc, rt.position`) : []
  const { releaseId: _releaseId, ...info } = album
  return { album: info, tracks: [...tracks] }
}
