/**
 * Editions of a release group with a title of their own, kept as edition rows. An album is a
 * release group, and its page shows one release of it; Tate McRae's deluxe "SO CLOSE TO
 * WHAT???" is a release in the group of "So Close to What", so without a row of its own it
 * could not be listed, opened or played. Each such edition (`namedEditions`) gets an edition
 * row (`albums.edition_of_id`, no MBID, the release as its track list), the same kind of
 * row a store album of another edition becomes (`album.ts`, `asEdition`). Artist pages show
 * the group once; album pages list the others as versions (`catalog/pages.ts`).
 *
 * Checked when a group's row is opened and was not checked in the last 30 days, in a job,
 * so the page does not wait for the release lookups.
 */
import { queryKeys } from '@squirmy/contracts'
import { sql } from 'drizzle-orm'
import { db } from '../../database/client.js'
import { albums } from '../../database/schema.js'
import { enqueue } from '../../jobs/index.js'
import { newId } from '../../lib/ids.js'
import { getServerSettings } from '../../lib/settings.js'
import { creditKey, matchKey } from '../../lib/text.js'
import { assignAlbumArtwork, remoteImage } from '../artwork/index.js'
import { uuidArray } from '../catalog/sql.js'
import { lockUpserts, upsertRelease } from '../matching/apply.js'
import { musicbrainz } from '../metadata/index.js'
import { genreNames } from './album.js'
import { namedEditions } from './canonical.js'
import { changed, currentId } from './rows.js'
import { warn } from './runner.js'

/** Payload of `enrichment.editions`. */
export type EditionsJob = { albumId: string }

/** SQL condition: the group row `a` is due an edition check. */
const due = sql`a.mbid is not null and a.edition_of_id is null and a.merged_into_id is null and a.detail_level >= 2
  and (a.editions_checked_at is null or a.editions_checked_at < now() - interval '30 days')`

/**
 * Queues `enrichment.editions` for a release group's row that has its track list and was
 * not checked in the last 30 days. Never throws: the page that asked renders regardless.
 */
export async function queueEditionCheck(albumId: string): Promise<void> {
  try {
    const [row] = await db.execute<{ due: boolean }>(sql`select ${due} as due from albums a where a.id = ${albumId}`)
    if (row?.due) await enqueue('enrichment.editions', { albumId } satisfies EditionsJob, { singletonKey: albumId, priority: -1 })
  } catch (error) {
    warn(`Could not queue the edition check of album ${albumId}`, error)
  }
}

type GroupRow = { id: string; mbid: string; artistCredit: string; primaryArtistId: string | null; type: string }

/**
 * Writes an edition row for each edition of the group with a title of its own that the
 * catalog does not hold yet: no edition row of the group shows that release or one of its
 * track count (a store album of that edition, kept by `asEdition`), and no row holds the
 * release at all. Returns the ids of the rows written. Provider failures propagate, and
 * the check then counts as not done.
 */
export async function keepNamedEditions(albumId: string): Promise<string[]> {
  const id = await currentId('album', albumId)
  if (!id) return []
  const [group] = await db.execute<GroupRow>(sql`
    select a.id, a.mbid, a.artist_credit as "artistCredit", a.primary_artist_id as "primaryArtistId", a.type
    from albums a where a.id = ${id} and a.mbid is not null and a.edition_of_id is null and a.merged_into_id is null`)
  if (!group) return []
  const releaseGroup = await musicbrainz.getReleaseGroup(group.mbid)
  const known = await db.execute<{ id: string; releaseMbid: string | null; trackCount: number | null }>(sql`
    select e.id, rl.mbid as "releaseMbid", rl.track_count as "trackCount"
    from albums e left join releases rl on rl.id = e.canonical_release_id
    where e.edition_of_id = ${group.id} and e.merged_into_id is null`)
  const candidates = releaseGroup ? namedEditions(releaseGroup) : []
  const held = candidates.length === 0 ? new Set<string>() : new Set((await db.execute<{ mbid: string }>(sql`
    select mbid::text from releases where mbid = any(${uuidArray(candidates.map((release) => release.mbid))})`)).map((row) => row.mbid))
  const missing = candidates.filter((release) => !held.has(release.mbid)
    && !known.some((edition) => edition.releaseMbid === release.mbid || edition.trackCount === release.trackCount))

  const written: string[] = []
  for (const summary of missing) {
    const release = await musicbrainz.getRelease(summary.mbid)
    if (!release) continue
    const editionId = newId()
    await db.transaction(async (tx) => {
      await lockUpserts(tx)
      await tx.insert(albums).values({
        id: editionId,
        title: release.title,
        artistCredit: group.artistCredit,
        primaryArtistId: group.primaryArtistId,
        type: group.type,
        editionOfId: group.id,
        titleKey: matchKey(release.title),
        matchKey: creditKey(group.artistCredit, release.title),
      })
      await upsertRelease(tx, release, {}, { canonical: 'always', editionAlbumId: editionId })
      // The edition came out when its release did, not with the album.
      await tx.update(albums).set({
        ...(release.date ? { releaseDate: release.date, year: release.year } : {}),
        genres: genreNames(releaseGroup?.genres ?? []), detailLevel: 2, fetchedAt: new Date(), updatedAt: new Date(),
      }).where(sql`${albums.id} = ${editionId}`)
    })
    written.push(editionId)
    if ((await getServerSettings()).coverArtArchiveEnabled) {
      const asset = await remoteImage(`https://coverartarchive.org/release/${release.mbid}/front-500`, { kind: 'cover' })
      await assignAlbumArtwork(editionId, asset.id, { onlyIfEmpty: true })
    }
  }
  await db.update(albums).set({ editionsCheckedAt: new Date() }).where(sql`${albums.id} = ${group.id}`)
  if (written.length > 0) await changed([group.id, ...known.map((edition) => edition.id)].map((one) => queryKeys.album(one)))
  return written
}
