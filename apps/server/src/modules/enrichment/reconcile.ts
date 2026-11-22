/**
 * One row per release on an artist's page. Album rows for one release arrive from several
 * places that cannot always see each other: search stubs from Deezer (sometimes credited
 * to a second row of the same artist, merged later), stubs made from a track's album
 * reference (no type), rows built from a delivered file's tags, and the MusicBrainz
 * discography. Each writer adopts what it can see; this pass catches what they missed
 * (a stub written while the discography ran, an artist merged after it, a store's type
 * that disagrees with MusicBrainz's).
 *
 * Within one artist (primary artist), rows whose titles share a `releaseKey` are one
 * release. "Anchors" are rows with an MBID or files; "loose" rows have neither. A loose row
 * merges into the anchor that fits it, else into the best loose row of the same release.
 * Anchors are never merged here: two MusicBrainz groups stay two rows (the artist page
 * shows one of them, `catalog/pages.ts`). Merges leave redirects and move files, editions,
 * likes, library saves, playlist items, plays and wants (`matching/merge.ts`), so nothing
 * that pointed at a loose row breaks. Running it again changes nothing.
 */
import { queryKeys } from '@squirmy/contracts'
import { sql } from 'drizzle-orm'
import { db, type Transaction } from '../../database/client.js'
import { lockUpserts } from '../matching/apply.js'
import { mergeAlbum } from '../matching/merge.js'
import { releaseKey } from '../search/keys.js'
import { changed } from './rows.js'

export type ReleaseRow = {
  id: string
  title: string
  type: string
  typeGuessed: boolean
  mbid: string | null
  year: number | null
  detailLevel: number
  hasFiles: boolean
  hasArtwork: boolean
}

/** Store and MusicBrainz types of one release often disagree within these families (Deezer's "ep" is MusicBrainz's "single"). */
const family = (type: string) => (type === 'single' || type === 'ep' ? 'short' : 'long')

/** Years more than this apart are different releases, whatever their titles. */
const yearSlack = 1
const yearsAgree = (a: ReleaseRow, b: ReleaseRow) => a.year === null || b.year === null || Math.abs(a.year - b.year) <= yearSlack

/**
 * The anchor a loose row is the same release as, or null when none or several fit equally.
 * A guessed type fits any anchor; a stated type fits its own type, else its family.
 */
function anchorFor(loose: ReleaseRow, anchors: readonly ReleaseRow[]): ReleaseRow | null {
  const fitting = anchors.filter((anchor) => yearsAgree(loose, anchor))
  const tiers = [
    fitting.filter((anchor) => anchor.type === loose.type),
    fitting.filter((anchor) => family(anchor.type) === family(loose.type)),
    loose.typeGuessed || fitting.every((anchor) => anchor.typeGuessed) ? fitting : [],
  ]
  for (const tier of tiers) {
    if (tier.length === 0) continue
    // Two MusicBrainz groups of one title and type ("Violence" twice): either is the
    // release, so the loose row joins the one the page shows (`catalog/pages.ts`).
    return [...tier].sort(compareRows)[0]!
  }
  return null
}

/** Which of two rows of one release should stand for it: files, an MBID, a stated type, detail, artwork, the earlier year, then age. */
function compareRows(a: ReleaseRow, b: ReleaseRow): number {
  const score = (row: ReleaseRow) => [row.hasFiles ? 0 : 1, row.mbid ? 0 : 1, row.typeGuessed ? 1 : 0, -row.detailLevel, row.hasArtwork ? 0 : 1, row.year ?? 9999]
  const left = score(a)
  const right = score(b)
  for (let index = 0; index < left.length; index++) if (left[index] !== right[index]) return left[index]! - right[index]!
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

/** Plans the merges for one artist's rows: [loser, winner] pairs, winners never losers. */
export function planReleaseMerges(rows: readonly ReleaseRow[]): [from: ReleaseRow, into: ReleaseRow][] {
  const groups = new Map<string, ReleaseRow[]>()
  for (const row of rows) {
    const key = releaseKey(row.title)
    if (!key) continue
    groups.set(key, [...(groups.get(key) ?? []), row])
  }
  const merges: [ReleaseRow, ReleaseRow][] = []
  for (const group of groups.values()) {
    if (group.length < 2) continue
    const anchors = group.filter((row) => row.mbid || row.hasFiles)
    const loose = group.filter((row) => !row.mbid && !row.hasFiles)
    const left: ReleaseRow[] = []
    for (const row of loose) {
      const into = anchorFor(row, anchors)
      if (into) merges.push([row, into])
      else left.push(row)
    }
    // Stubs of one release that no anchor took: the best one stands for the others it fits.
    const sorted = left.sort(compareRows)
    const kept: ReleaseRow[] = []
    for (const row of sorted) {
      const into = kept.find((one) => yearsAgree(one, row)
        && (one.type === row.type || one.typeGuessed || row.typeGuessed || family(one.type) === family(row.type)))
      if (into) merges.push([row, into])
      else kept.push(row)
    }
  }
  return merges
}

async function artistRows(tx: Transaction, artistId: string): Promise<ReleaseRow[]> {
  return tx.execute<ReleaseRow>(sql`
    select a.id, a.title, a.type, a.type_guessed as "typeGuessed", a.mbid, a.year, a.detail_level as "detailLevel",
      exists (select 1 from media_files f where f.album_id = a.id) as "hasFiles",
      a.artwork_asset_id is not null as "hasArtwork"
    from albums a
    where a.primary_artist_id = ${artistId} and a.merged_into_id is null`)
}

/**
 * Merges an artist's duplicate album rows (see the file comment). Returns the ids of the
 * rows merged away. Takes the catalog lock, so it never interleaves with an upsert.
 */
export async function reconcileArtistAlbums(artistId: string): Promise<string[]> {
  const merged = await db.transaction(async (tx) => {
    await lockUpserts(tx)
    const merges = planReleaseMerges(await artistRows(tx, artistId))
    for (const [from, into] of merges) {
      await mergeAlbum(from.id, into.id, tx)
      // A row from tags or a track reference learns the type a source stated for the release.
      if (into.typeGuessed && !from.typeGuessed && !into.mbid) {
        await tx.execute(sql`update albums set type = ${from.type}, type_guessed = false, updated_at = now() where id = ${into.id} and type_guessed`)
      }
    }
    return merges
  })
  if (merged.length > 0) {
    await changed([queryKeys.artist(artistId), ...merged.flatMap(([from, into]) => [queryKeys.album(from.id), queryKeys.album(into.id)])])
  }
  return merged.map(([from]) => from.id)
}

/** Artists per repair page. */
const repairBatch = 200

/**
 * Runs `reconcileArtistAlbums` for every artist that has a loose album row beside another
 * row, in pages of artist ids. Idempotent: the repair for rows written before this pass
 * existed, run at worker start and daily. Returns how many rows it merged.
 */
export async function reconcileAllArtists(): Promise<number> {
  let after = '00000000-0000-0000-0000-000000000000'
  let total = 0
  for (;;) {
    const page = await db.execute<{ id: string }>(sql`
      select distinct a.primary_artist_id as id from albums a
      where a.primary_artist_id > ${after}::uuid and a.merged_into_id is null and a.mbid is null
        and not exists (select 1 from media_files f where f.album_id = a.id)
        and exists (select 1 from albums other where other.primary_artist_id = a.primary_artist_id
          and other.id <> a.id and other.merged_into_id is null)
      order by a.primary_artist_id limit ${repairBatch}`)
    for (const row of page) total += (await reconcileArtistAlbums(row.id)).length
    if (page.length < repairBatch) return total
    after = page.at(-1)!.id
  }
}
