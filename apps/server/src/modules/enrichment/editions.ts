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
