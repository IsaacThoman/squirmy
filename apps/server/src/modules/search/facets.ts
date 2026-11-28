import type { SearchFacets } from '@squirmy/contracts'
import { sql, type SQL } from 'drizzle-orm'
import type { LibraryKind } from './library.js'

/** A quality and decade selected together must match the same release's file. */
export function searchFacetConditions(kind: LibraryKind, alias: 'a' | 't', userId: string, filters: SearchFacets): SQL {
  const { liked, quality, decade } = filters
  const id = sql.raw(`${alias}.id`)
  const entity = kind === 'track' ? 'recording' : kind
  const heart = liked
    ? sql`exists (select 1 from likes l where l.entity_id = ${id} and l.user_id = ${userId} and l.entity_type = ${entity})`
    : sql`true`

  if (!quality && decade === undefined) return heart
  const year = (expression: SQL) => decade === undefined ? sql`true` : sql`${expression} >= ${decade} and ${expression} < ${decade + 10}`
  const source = quality === 'hi-res' ? sql`f.lossless and (f.bit_depth > 16 or f.sample_rate > 48000)` : sql`f.lossless`
  const matchingFile = sql`f.missing_since is null and ${source}`

  if (kind === 'album') {
    const file = quality ? sql`exists (select 1 from media_files f where f.album_id = ${id} and ${matchingFile})` : sql`true`
    return sql`${heart} and ${year(sql`t.year`)} and ${file}`
  }

  if (kind === 'artist') {
    const albums = sql`select aa.album_id as id from album_artists aa where aa.artist_id = ${id}`
    const files = sql`
      select f.album_id from media_files f join recording_artists ra on ra.recording_id = f.recording_id
      where ra.artist_id = ${id} and ${matchingFile}
      union all
      select f.album_id from (${albums}) credited join media_files f on f.album_id = credited.id where ${matchingFile}`
    if (quality && decade === undefined) return sql`${heart} and exists (${files})`
    return sql`${heart} and exists (
      select 1 from (${quality ? files : albums}) r(id) join albums d on d.id = r.id where ${year(sql`d.year`)})`
  }

  if (quality) {
    const album = decade === undefined ? sql`` : sql`join albums d on d.id = f.album_id`
    return sql`${heart} and exists (select 1 from media_files f ${album}
      where f.recording_id = ${id} and ${matchingFile} and ${year(sql`d.year`)})`
  }
  return sql`${heart} and exists (
    select 1 from (
      select f.album_id from media_files f where f.recording_id = ${id} and f.missing_since is null
      union all
      select r.album_id from release_tracks rt join releases r on r.id = rt.release_id where rt.recording_id = ${id}
      union all
      select t.album_hint_id
    ) r(album_id) join albums d on d.id = r.album_id where ${year(sql`d.year`)})`
}
