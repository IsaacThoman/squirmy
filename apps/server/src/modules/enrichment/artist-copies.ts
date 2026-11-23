/**
 * Second Deezer pages of one artist. Deezer keeps more than one page for some artists
 * (Grimes is 807493 and 285342121; Boards of Canada, 1098 and 412310471), and search
 * stores a Deezer id it does not know as an artist of its own when the artist of that name
 * already has another Deezer id, because namesakes are real (materialize.ts). Both rows
 * then show in search. This tells the two cases apart and merges a second page into the
 * artist it belongs to; a real namesake stays a row of its own.
 *
 * A Deezer-only row is the same artist as another row of its name when:
 * 1. MusicBrainz links its Deezer page to that row's MBID (the strongest sign; a page
 *    MusicBrainz links to another artist is a namesake), or
 * 2. the two share a release (`releaseKey`) or two songs (`editionFreeKey`): for a row with
 *    an MBID, of what MusicBrainz credits it with; for a Deezer-only row, of its credits
 *    and what its Deezer pages list (albums, popular tracks).
 * When several rows qualify, the one with an MBID wins if it is the only one; otherwise
 * nothing is merged. A row whose page lists nothing (an empty page) is left alone.
 */
import { queryKeys } from '@squirmy/contracts'
import { eq, sql } from 'drizzle-orm'
import { db } from '../../database/client.js'
import { getServerSettings } from '../../lib/settings.js'
import { lockUpserts } from '../matching/apply.js'
import { mergeArtist, resolveMerged } from '../matching/merge.js'
import { deezer, musicbrainz } from '../metadata/index.js'
import { artists } from '../../database/schema.js'
import { editionFreeKey, releaseKey, sameArtist, type ArtistTitles } from '../search/keys.js'
import { reconcileArtistAlbums } from './reconcile.js'
import { attempt, changed } from './rows.js'

/** Rows looked at per repair run: each costs a few Deezer requests and, with MusicBrainz on, one lookup a second. */
const batch = 300

/**
 * How long a row kept as a namesake is left alone. The evidence can change (the other row
 * gains releases, MusicBrainz adds a link), but rarely; checking kept rows on every run
 * spent most of each batch on them, and the rows not yet checked waited for days.
 */
const recheckAfter = '30 days'

const empty = (): ArtistTitles => ({ albums: new Set(), tracks: new Set() })
const add = (into: ArtistTitles, from: ArtistTitles) => {
  for (const album of from.albums) into.albums.add(album)
  for (const track of from.tracks) into.tracks.add(track)
}

async function deezerPage(deezerId: string): Promise<ArtistTitles> {
  const titles = empty()
  const [albums, top] = await Promise.all([deezer.getArtistAlbums(Number(deezerId)), deezer.getArtistTopTracks(Number(deezerId), { limit: 25 })])
  for (const album of albums) titles.albums.add(releaseKey(album.title))
  for (const track of top) titles.tracks.add(editionFreeKey(track.title))
  return titles
}

/**
 * What a row is known by. A row with an MBID: what MusicBrainz credits it with (albums and
 * recordings with an MBID), nothing else. Its other credits and Deezer pages may have come
 * from earlier merges or from search crediting a namesake by name, and counting them let
 * one wrong merge pull in the next (three other "Genesis" pages into the band). A row
 * without one: its credits and what its Deezer pages list.
 */
async function rowTitles(artistId: string, deezerIds: readonly string[], fromMusicBrainz: boolean): Promise<ArtistTitles> {
  const titles = empty()
  const sourced = sql.raw(fromMusicBrainz ? 'and x.mbid is not null' : '')
  const rows = await db.execute<{ kind: string; title: string }>(sql`
    select 'album' as kind, x.title from album_artists aa join albums x on x.id = aa.album_id where aa.artist_id = ${artistId} ${sourced}
    union select 'track', x.title from recording_artists ra join recordings x on x.id = ra.recording_id where ra.artist_id = ${artistId} ${sourced}`)
  for (const row of rows) {
    if (row.kind === 'album') titles.albums.add(releaseKey(row.title))
    else titles.tracks.add(editionFreeKey(row.title))
  }
  if (!fromMusicBrainz) for (const id of deezerIds) add(titles, await deezerPage(id))
  titles.albums.delete('')
  titles.tracks.delete('')
  return titles
}

type Row = { id: string; mbid: string | null; nameKey: string; deezerIds: string[]; credits: number }

async function sameNameRows(artistId: string): Promise<{ self: Row; others: Row[] } | null> {
  const rows = await db.execute<Row>(sql`
    select a.id, a.mbid, a.name_key as "nameKey",
      coalesce((select array_agg(e.external_id order by e.external_id) from external_ids e
        where e.provider = 'deezer' and e.entity_type = 'artist' and e.entity_id = a.id), '{}') as "deezerIds",
      ((select count(*) from album_artists aa where aa.artist_id = a.id) + (select count(*) from recording_artists ra where ra.artist_id = a.id))::int as credits
    from artists a
    where a.merged_into_id is null and a.name_key = (select name_key from artists where id = ${artistId})`)
  const self = rows.find((row) => row.id === artistId)
  return self ? { self, others: rows.filter((row) => row.id !== artistId) } : null
}

/**
 * The row a Deezer-only artist row is a second page of, or null when it is a namesake or
 * the evidence is not sure (see the file comment).
 */
export async function copyOf(artistId: string): Promise<string | null> {
  const found = await sameNameRows(artistId)
  if (!found || found.self.mbid || found.self.deezerIds.length === 0 || found.others.length === 0) return null
  const { self, others } = found
  if ((await getServerSettings()).musicBrainzEnabled) {
    const linked = new Set<string>()
    for (const deezerId of self.deezerIds) {
      const links = await musicbrainz.lookupUrl(`https://www.deezer.com/artist/${deezerId}`)
      for (const artist of links?.artists ?? []) linked.add(artist.mbid)
    }
    const target = others.find((row) => row.mbid && linked.has(row.mbid))
    if (target) return target.id
    // MusicBrainz names someone else for the page: a namesake of these rows (the band
    // Beach House beside another "Beach House" MusicBrainz knows), whatever titles say.
    if (linked.size > 0) return null
  }
  const mine = await rowTitles(self.id, self.deezerIds, false)
  if (mine.albums.size === 0 && mine.tracks.size === 0) return null
  const fitting: Row[] = []
  for (const other of others) if (sameArtist(mine, await rowTitles(other.id, other.deezerIds, Boolean(other.mbid)), self.nameKey)) fitting.push(other)
  if (fitting.length === 1) return fitting[0]!.id
  const withMbid = fitting.filter((row) => row.mbid)
  return withMbid.length === 1 ? withMbid[0]!.id : null
}

/**
 * Which of two rows of one artist stands for it when both lack an MBID: the one with more
 * credits, then the older. A second page never takes in the first.
 */
const ranksAbove = (a: Row, b: Row) => (a.mbid ? 1 : 0) - (b.mbid ? 1 : 0) || a.credits - b.credits || (a.id < b.id ? 1 : -1)

/**
 * Merges a Deezer-only row into the artist it is a second page of, keeping likes, ratings,
 * credits and its Deezer id (`mergeArtist`), then folds the albums it brought into the
 * artist's (reconcile.ts). Returns the row it went into, or null.
 */
export async function foldArtistCopy(artistId: string): Promise<string | null> {
  const into = await copyOf(artistId)
  const found = into ? await sameNameRows(artistId) : null
  const target = found?.others.find((row) => row.id === into)
  if (!into || !found || !target || ranksAbove(target, found.self) <= 0) {
    // Kept. A failed request throws before this, so that row is checked again next run.
    await db.update(artists).set({ copyCheckedAt: new Date() }).where(eq(artists.id, artistId))
    return null
  }
  await db.transaction(async (tx) => {
    await lockUpserts(tx)
    if ((await resolveMerged(tx, artists, artistId)) !== artistId) return
    await mergeArtist(artistId, into, tx)
  })
  await reconcileArtistAlbums(into)
  await changed([queryKeys.artist(artistId), queryKeys.artist(into)])
  return into
}

/**
 * The repair: up to {@link batch} Deezer-only rows that share a name with another row, each
 * merged when it is a second page. Rows never checked come first, then in a daily order;
 * a row kept as a namesake waits {@link recheckAfter}, so the batches work through every
 * row in turn. Returns how many were merged. Running it again changes nothing for rows
 * already decided.
 */
export async function foldArtistCopies(): Promise<number> {
  if (!(await getServerSettings()).deezerEnabled) return 0
  const rows = await db.execute<{ id: string }>(sql`
    select a.id from artists a
    where a.merged_into_id is null and a.mbid is null
      and exists (select 1 from external_ids e where e.provider = 'deezer' and e.entity_type = 'artist' and e.entity_id = a.id)
      and exists (select 1 from artists other where other.name_key = a.name_key and other.id <> a.id and other.merged_into_id is null)
      and (a.copy_checked_at is null or a.copy_checked_at < now() - ${recheckAfter}::interval)
    order by a.copy_checked_at nulls first, md5(a.id::text || current_date::text) limit ${batch}`)
  let merged = 0
  for (const row of rows) {
    await attempt('artist copy', async () => {
      if (await foldArtistCopy(row.id)) merged++
    })
  }
  return merged
}
