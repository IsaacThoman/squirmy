/**
 * Splits store editions that were merged into their release group's row before editions
 * were kept apart (`album.ts`, `asEdition`). Opening "SOS Deluxe: LANA" or "Midnights (3am
 * Edition)" bridged it to the group and merged it there, so the page turned into the
 * standard album seconds later and the deluxe songs were gone.
 *
 * A group row's Deezer albums are compared with its track list: one whose track count
 * differs and whose title names an edition the group's does not is another edition. It moves to the row it was merged from (found by title and
 * merged into this row), which is un-merged and becomes an edition row, or else to a new
 * edition row; a track list Deezer built for it under the group's row moves along. The
 * edition then fetches its own MusicBrainz release when it is opened. What the merge moved
 * to the group's row (likes, plays) stays there. Running it again changes nothing.
 */
import { queryKeys } from '@squirmy/contracts'
import { sql } from 'drizzle-orm'
import { db } from '../../database/client.js'
import { albumArtists, albums } from '../../database/schema.js'
import { newId } from '../../lib/ids.js'
import { creditKey, matchKey } from '../../lib/text.js'
import { remoteImage } from '../artwork/index.js'
import { lockUpserts } from '../matching/apply.js'
import { mergeAlbum } from '../matching/merge.js'
import { deezer } from '../metadata/index.js'
import { labelFreeKey } from '../search/keys.js'
import type { DeezerAlbum } from '../metadata/deezer.js'
import { attempt, changed } from './rows.js'

type Group = { id: string; title: string; artistCredit: string; primaryArtistId: string | null; type: string; year: number | null; releaseDate: string | null; trackCount: number }

/** Group rows looked at per run: each costs one Deezer request per Deezer album it holds. */
const batch = 100

/**
 * Splits up to {@link batch} group rows' merged editions. Returns how many editions were
 * split off.
 */
export async function splitMergedEditions(): Promise<number> {
  // Group rows with a MusicBrainz track list that hold more than one Deezer album, or that
  // a row of another title was merged into.
  const groups = await db.execute<Group>(sql`
    select g.id, g.title, g.artist_credit as "artistCredit", g.primary_artist_id as "primaryArtistId", g.type, g.year,
      g.release_date as "releaseDate", rl.track_count as "trackCount"
    from albums g join releases rl on rl.id = g.canonical_release_id and rl.mbid is not null
    where g.mbid is not null and g.merged_into_id is null
      and ((select count(*) from external_ids e where e.provider = 'deezer' and e.entity_type = 'album' and e.entity_id = g.id) > 1
        or exists (select 1 from albums m where m.merged_into_id = g.id and m.mbid is null and m.title_key <> g.title_key)
          and exists (select 1 from external_ids e where e.provider = 'deezer' and e.entity_type = 'album' and e.entity_id = g.id))
    order by md5(g.id::text || current_date::text) limit ${batch}`)
  let split = 0
  for (const group of groups) {
    const ids = await db.execute<{ id: string }>(sql`
      select external_id as id from external_ids where provider = 'deezer' and entity_type = 'album' and entity_id = ${group.id} order by external_id`)
    for (const { id } of ids) {
      let album: DeezerAlbum | null = null
      if (!(await attempt('edition check', async () => { album = await deezer.getAlbum(Number(id)) }))) continue
      const edition = album as DeezerAlbum | null
      // The same track count is the same edition, however it is titled (a 2009 remaster);
      // so is a copy under the group's own title that lacks a track the store lacks.
      if (!edition || edition.tracks.length === 0 || edition.tracks.length === group.trackCount) continue
      if (labelFreeKey(edition.title) === labelFreeKey(group.title)) continue
      await splitOff(group, id, edition)
      split++
    }
  }
  return split
}

async function splitOff(group: Group, deezerId: string, edition: DeezerAlbum) {
  const cover = edition.coverUrl ? await remoteImage(edition.coverUrl, { kind: 'cover' }) : null
  const editionId = await db.transaction(async (tx) => {
    await lockUpserts(tx)
    const [merged] = await tx.execute<{ id: string }>(sql`
      select id from albums where merged_into_id = ${group.id} and mbid is null and title_key = ${matchKey(edition.title)}
      order by id limit 1`)
    let id = merged?.id
    if (id) {
      await tx.execute(sql`
        update albums set merged_into_id = null, edition_of_id = ${group.id}, canonical_release_id = null, detail_level = 0,
          fetched_at = null, updated_at = now()
        where id = ${id}`)
    } else {
      id = newId()
      await tx.insert(albums).values({
        id,
        title: edition.title,
        artistCredit: group.artistCredit,
        primaryArtistId: group.primaryArtistId,
        type: group.type,
        year: group.year,
        releaseDate: group.releaseDate,
        titleKey: matchKey(edition.title),
        matchKey: creditKey(group.artistCredit, edition.title),
        artworkAssetId: cover?.id ?? null,
        detailLevel: 0,
        editionOfId: group.id,
      })
      await tx.execute(sql`
        insert into ${albumArtists} (album_id, position, artist_id, credited_name, join_phrase)
        select ${id}, position, artist_id, credited_name, join_phrase from ${albumArtists} where album_id = ${group.id}`)
    }
    await tx.execute(sql`
      update external_ids set entity_id = ${id} where provider = 'deezer' and entity_type = 'album' and external_id = ${deezerId}`)
    // The track list Deezer built for the edition under the group's row goes with it.
    const [built] = await tx.execute<{ id: string }>(sql`
      update releases rl set album_id = ${id}, updated_at = now()
      from albums g
      where g.id = ${group.id} and rl.album_id = g.id and rl.id is distinct from g.canonical_release_id and rl.mbid is null
        and lower(regexp_replace(rl.title, '[^[:alnum:]]', '', 'g')) = lower(regexp_replace(${edition.title}, '[^[:alnum:]]', '', 'g'))
        and not exists (select 1 from media_files f where f.release_id = rl.id)
      returning rl.id`)
    if (built) await tx.execute(sql`update albums set canonical_release_id = ${built.id}, detail_level = 1 where id = ${id}`)
    return id
  })
  await changed([queryKeys.album(editionId), queryKeys.album(group.id)])
}

type EditionRow = { id: string; title: string; editionOfId: string; releaseId: string | null; hasMbRelease: boolean; detailLevel: number; deezerId: string | null }

/**
 * What an edition row's songs are: its track count and ISRCs in track order, from its
 * track list, else from its Deezer album. Null when a track has no ISRC: then two rows
 * cannot be told to be the same edition.
 */
async function fingerprint(row: EditionRow): Promise<string | null> {
  if (row.releaseId) {
    const tracks = await db.execute<{ isrc: string | null }>(sql`
      select (select min(isrc) from unnest(r.isrcs) as isrc) as isrc
      from release_tracks rt join recordings r on r.id = rt.recording_id
      where rt.release_id = ${row.releaseId} order by rt.disc, rt.position`)
    if (tracks.length > 0) return tracks.every((track) => track.isrc) ? tracks.map((track) => track.isrc).join(',') : null
  }
  if (!row.deezerId) return null
  let album: DeezerAlbum | null = null
  await attempt('edition fingerprint', async () => { album = await deezer.getAlbum(Number(row.deezerId)) })
  const tracks = (album as DeezerAlbum | null)?.tracks ?? []
  return tracks.length > 0 && tracks.every((track) => track.isrc) ? tracks.map((track) => track.isrc!.toUpperCase()).join(',') : null
}

/**
 * Merges edition rows of one release group that are one edition: the same name, the same
 * track count and the same ISRCs in order (two Deezer copies of one album). Rows that differ
 * in a song (the explicit and the clean version, a re-sequenced pressing) stay apart; search
 * shows one card per name either way. The row with a MusicBrainz track list, then the more
 * complete, then the older, stands for them. Returns how many rows were merged away.
 */
export async function mergeDuplicateEditions(): Promise<number> {
  const rows = await db.execute<EditionRow>(sql`
    select a.id, a.title, a.edition_of_id as "editionOfId", a.canonical_release_id as "releaseId",
      exists (select 1 from releases rl where rl.id = a.canonical_release_id and rl.mbid is not null) as "hasMbRelease",
      a.detail_level as "detailLevel",
      (select min(e.external_id) from external_ids e where e.provider = 'deezer' and e.entity_type = 'album' and e.entity_id = a.id) as "deezerId"
    from albums a
    where a.edition_of_id is not null and a.merged_into_id is null
      and exists (select 1 from albums b where b.edition_of_id = a.edition_of_id and b.id <> a.id and b.merged_into_id is null)
    order by a.id`)
  const groups = new Map<string, EditionRow[]>()
  for (const row of rows) {
    const key = `${row.editionOfId}|${labelFreeKey(row.title)}`
    groups.set(key, [...(groups.get(key) ?? []), row])
  }
  const rank = (row: EditionRow) => [row.hasMbRelease ? 0 : 1, -row.detailLevel] as const
  let merged = 0
  for (const group of groups.values()) {
    if (group.length < 2) continue
    const sorted = [...group].sort((a, b) => rank(a)[0] - rank(b)[0] || rank(a)[1] - rank(b)[1] || (a.id < b.id ? -1 : 1))
    const kept: { row: EditionRow; songs: string }[] = []
    for (const row of sorted) {
      const songs = await fingerprint(row)
      if (!songs) continue
      const same = kept.find((one) => one.songs === songs)
      if (!same) {
        kept.push({ row, songs })
        continue
      }
      await db.transaction(async (tx) => {
        await lockUpserts(tx)
        await mergeAlbum(row.id, same.row.id, tx)
      })
      await changed([queryKeys.album(row.id), queryKeys.album(same.row.id)])
      merged++
    }
  }
  return merged
}
