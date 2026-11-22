/**
 * Album detail: a canonical MusicBrainz release with its full track list, reached from a
 * release-group MBID or bridged from a Deezer id, and a Deezer track list when there is
 * no MusicBrainz match.
 */
import { queryKeys, type AlbumType } from '@squirmy/contracts'
import { and, eq, isNull, sql } from 'drizzle-orm'
import { db, type Executor, type Transaction } from '../../database/client.js'
import { albumArtists, albums, externalIds, releases } from '../../database/schema.js'
import { newId } from '../../lib/ids.js'
import { creditKey, matchKey } from '../../lib/text.js'
import { lockUpserts, replaceCredits, upsertArtists, upsertRelease } from '../matching/apply.js'
import { mergeAlbum, resolveMerged } from '../matching/merge.js'
import { labelFreeKey, releaseKey } from '../search/keys.js'
import { deezer, musicbrainz } from '../metadata/index.js'
import type { DeezerAlbum } from '../metadata/deezer.js'
import type { MbReleaseGroup } from '../metadata/musicbrainz.js'
import { bridgeAlbum, type BridgedAlbum } from './bridge.js'
import { chooseCanonicalRelease, type EditionHint } from './canonical.js'
import { buildFromDeezer, creditDeezerTracks, linkDeezerAlbum } from './deezer-rows.js'
import { fitStrayRecordings, standInsFor } from './fit.js'
import { adoptMbid, albumOwned, attempt, changed, currentId, day, linkExternalId } from './rows.js'

/** A complete album is refreshed after this long. */
const refreshAfterMs = 30 * day
/** An album built from Deezer tries the MusicBrainz bridge again after this long. */
const bridgeRetryMs = day
const maxGenres = 5

type AlbumRow = Pick<typeof albums.$inferSelect, 'id' | 'mbid' | 'title' | 'artistCredit' | 'type' | 'detailLevel' | 'fetchedAt' | 'canonicalReleaseId'>
  & { canonicalMbid: string | null }

/** Whether the album is as complete as a recent run could make it. */
function fresh(album: AlbumRow, now: number): boolean {
  const age = album.fetchedAt ? now - album.fetchedAt.getTime() : Infinity
  // A release group whose row shows a local or Deezer edition (a local album merged into
  // it, say) still needs a MusicBrainz track list.
  if (album.mbid && !album.canonicalMbid) return false
  if (album.detailLevel >= 2) return age < refreshAfterMs
  // Built from Deezer: the bridge found nothing a moment ago.
  return !album.mbid && album.canonicalReleaseId !== null && age < bridgeRetryMs
}

export const genreNames = (genres: { name: string }[]) => genres.slice(0, maxGenres).map((genre) => genre.name)

/**
 * Brings an album to `detail_level` 2 when its sources allow, following merges. Returns
 * the id of the row that holds the album afterwards (a stub may have been merged into an
 * existing MusicBrainz row), or null when there is no such album. Provider failures
 * propagate; whatever was written before them stays.
 */
export async function hydrateAlbum(id: string, { force = false, usable }: { force?: boolean; usable?: () => void } = {}): Promise<string | null> {
  const albumId = await currentId('album', id)
  if (!albumId) return null
  const [album] = await db.select({
    id: albums.id, mbid: albums.mbid, title: albums.title, artistCredit: albums.artistCredit, type: albums.type,
    detailLevel: albums.detailLevel, fetchedAt: albums.fetchedAt, canonicalReleaseId: albums.canonicalReleaseId, canonicalMbid: releases.mbid,
    editionOfId: albums.editionOfId,
  }).from(albums).leftJoin(releases, eq(releases.id, albums.canonicalReleaseId)).where(eq(albums.id, albumId))
  if (!album || (!force && fresh(album, Date.now()))) return albumId

  let deezerId = await deezerAlbumOf(albumId)
  if (!album.mbid && !deezerId) return albumId
  // A release group only MusicBrainz listed (an artist page's discography) has no track
  // list for minutes while MusicBrainz is busy: Deezer's copy of it stands in meanwhile.
  if (!deezerId && !(await hasTrackList(albumId))) deezerId = await deezerStandIn(albumId, album)
  let dz: DeezerAlbum | null | undefined
  let result = albumId
  // Announced even when a later step fails: what earlier steps committed (a merge into
  // the MusicBrainz album, stand-in recordings folded into it) is already visible.
  try {
    if (deezerId && !(await hasTrackList(albumId))) {
      // MusicBrainz takes a request a second and a bridge or release several, more than a
      // page waits; Deezer's track list stands in meanwhile and becomes the release later.
      await attempt('Deezer track list', async () => {
        dz = await deezer.getAlbum(Number(deezerId))
        if (!dz) return
        await buildFromDeezer(albumId, dz)
        usable?.()
      })
    }
    // An edition row already knows its group; a store album is bridged to one.
    const parentMbid = album.editionOfId ? await groupMbidOf(album.editionOfId) : null
    const bridged: BridgedAlbum | null = album.mbid || parentMbid || !deezerId ? null
      : await bridgeAlbum(deezerId, { title: album.title, artist: album.artistCredit, type: album.type as AlbumType })
    const groupMbid = album.mbid ?? parentMbid ?? bridged?.group ?? null
    if (groupMbid) {
      const group = await musicbrainz.getReleaseGroup(groupMbid)
      if (dz === undefined && !album.mbid && deezerId) dz = await deezer.getAlbum(Number(deezerId))
      // A store album is one edition of the group, as far as the store says which; a row
      // that is the group itself shows the group's own choice.
      const edition: EditionHint | null = album.mbid || !dz ? null : { releaseMbid: bridged?.release ?? null, barcode: dz.upc, trackCount: dz.tracks.length }
      if (group && (edition || !album.editionOfId)) result = await fromMusicBrainz(albumId, group, edition && { ...edition, title: album.title })
    }
    const [after] = await db.select({ detailLevel: albums.detailLevel }).from(albums).where(eq(albums.id, result))
    if (dz === undefined) dz = deezerId ? await deezer.getAlbum(Number(deezerId)) : null
    if (dz && (after?.detailLevel ?? 0) < 2) {
      const built = dz
      await buildFromDeezer(result, built)
      // A track list only Deezer has: its guests come from each track's own entry.
      await attempt('featured artists', () => creditDeezerTracks(built))
    }
    if (dz) await linkDeezerAlbum(result, dz)
  } finally {
    await changed([queryKeys.album(result), ...(result === albumId ? [] : [queryKeys.album(albumId)])])
  }
  return result
}

const shortForm = (type: string) => type === 'single' || type === 'ep'

/**
 * Deezer's album for a release group that has no Deezer id: a search for its credit and
 * title, taking the first hit by the same artist of the same release (the same title
 * first, else the same `releaseKey`) and of a like length (single or EP, else longer).
 * Its id is recorded on the album, so the Deezer track list stands in and later links
 * its tracks to MusicBrainz's. Null when none is sure or Deezer is off or failing.
 */
async function deezerStandIn(albumId: string, album: Pick<AlbumRow, 'title' | 'artistCredit' | 'type'>): Promise<string | null> {
  let found: string | null = null
  await attempt('Deezer album search', async () => {
    const { albums: hits } = await deezer.search(`${album.artistCredit} ${album.title}`, { types: ['album'], limit: 10 })
    const credit = matchKey(album.artistCredit)
    const candidates = hits.filter((hit) => {
      const artist = matchKey(hit.artist.name)
      return artist && (credit === artist || credit.startsWith(`${artist} `)) && shortForm(hit.type) === shortForm(album.type)
    })
    const hit = candidates.find((one) => matchKey(one.title) === matchKey(album.title))
      ?? candidates.find((one) => releaseKey(one.title) === releaseKey(album.title))
    if (hit && await linkExternalId('deezer', 'album', String(hit.id), albumId)) found = String(hit.id)
  })
  return found
}

/**
 * The Deezer album to build an album from: its one Deezer id, or of several (the explicit
 * and the clean version of one album, or two copies), the explicit one, so the page shows
 * the songs as released rather than the radio edit.
 */
export async function deezerAlbumOf(albumId: string): Promise<string | null> {
  const rows = await db.select({ id: externalIds.externalId }).from(externalIds)
    .where(and(eq(externalIds.provider, 'deezer'), eq(externalIds.entityType, 'album'), eq(externalIds.entityId, albumId)))
    .orderBy(externalIds.createdAt, externalIds.externalId)
  if (rows.length <= 1) return rows[0]?.id ?? null
  for (const row of rows) {
    const one = await deezer.getAlbum(Number(row.id)).catch(() => null)
    if (one?.explicit) return row.id
  }
  return rows[0]!.id
}

async function groupMbidOf(albumId: string): Promise<string | null> {
  const [row] = await db.select({ mbid: albums.mbid }).from(albums).where(eq(albums.id, albumId))
  return row?.mbid ?? null
}

/** Whether the album has any edition with tracks yet. */
async function hasTrackList(albumId: string): Promise<boolean> {
  const [row] = await db.execute<{ found: boolean }>(sql`
    select exists (select 1 from releases rl join release_tracks rt on rt.release_id = rl.id where rl.album_id = ${albumId}) as found`)
  return Boolean(row?.found)
}

/**
 * Whether an album keeps the canonical release it has: one from MusicBrainz that its
 * files are on. An album whose files sit on a local edition (a local album merged into
 * the group's row) takes the group's canonical release, and its files' recordings are
 * fitted to its tracks.
 */
async function keepsCanonical(albumId: string, executor: Executor = db): Promise<boolean> {
  const [row] = await executor.execute<{ keeps: boolean }>(sql`
    select exists (select 1 from albums a join releases rl on rl.id = a.canonical_release_id
      where a.id = ${albumId} and rl.mbid is not null) as keeps`)
  return Boolean(row?.keeps) && await albumOwned(albumId, executor)
}

/**
 * Writes the group's canonical release under the album row, merging the row into the
 * group's own row when one exists (a bridged stub) or MusicBrainz answered with another
 * id (a merge on their side), then folds recordings that stood in for its tracks into
 * them (`fit.ts`). An album with files on a MusicBrainz edition keeps it.
 *
 * A store album is another edition ("SOS Deluxe: LANA", the 3am edition of "Midnights", a
 * deluxe "Watch the Throne") when its track count differs from the group's own edition's
 * and either a release of the group has its track count or its title names an edition the
 * group's does not. It stays a row of its own (`asEdition`), so the page opened for it
 * keeps its songs instead of turning into the standard album a few seconds later. A store
 * copy that only lacks a track (a song not licensed there) is the group's own edition.
 */
async function fromMusicBrainz(albumId: string, group: MbReleaseGroup, edition: (EditionHint & { title: string }) | null): Promise<string> {
  const standard = chooseCanonicalRelease(group.releases)
  if (edition?.trackCount && standard && edition.trackCount !== standard.trackCount) {
    const own = chooseCanonicalRelease(group.releases, edition)
    const counted = own && own.trackCount === edition.trackCount ? own : null
    if (counted || labelFreeKey(edition.title) !== labelFreeKey(group.title)) return asEdition(albumId, group, counted?.mbid ?? null)
  }
  const chosen = (await keepsCanonical(albumId)) ? null : standard
  const release = chosen ? await musicbrainz.getRelease(chosen.mbid) : null
  return db.transaction(async (tx) => {
    await lockUpserts(tx)
    let target = await adoptMbid(tx, 'album', albumId, group.mbid)
    if (release && !(await keepsCanonical(target, tx))) {
      // A track list built from Deezer becomes this release; an edition files are on stays.
      const providerReleases = (await tx.select({ id: releases.id }).from(releases)
        .where(and(eq(releases.albumId, target), isNull(releases.mbid),
          sql`not exists (select 1 from media_files f where f.release_id = ${releases.id})`))).map((row) => row.id)
      // The songs the album already lists (Deezer's track list, a delivery's) keep their rows.
      const recordings = await standInsFor(tx, target, release)
      const upserted = await upsertRelease(tx, release, { releaseIds: providerReleases, recordings }, { canonical: 'always' })
      if (upserted.albumId !== target) {
        await mergeAlbum(target, upserted.albumId, tx)
        target = upserted.albumId
      }
    }
    await fitStrayRecordings(tx, target)
    await tx.update(albums).set({ genres: genreNames(group.genres), detailLevel: 2, fetchedAt: new Date(), updatedAt: new Date() }).where(eq(albums.id, target))
    return target
  })
}

/**
 * The row of a release group, by MBID, else a new one at `detail_level` 1 (as the
 * discography writes them) with its credits. Its track list is fetched when it is opened.
 */
async function groupRow(tx: Transaction, group: MbReleaseGroup): Promise<string> {
  const [known] = await tx.select({ id: albums.id }).from(albums).where(eq(albums.mbid, group.mbid))
  if (known) return resolveMerged(tx, albums, known.id)
  const artistIds = await upsertArtists(tx, group.artistCredit)
  const id = newId()
  await tx.insert(albums).values({
    id,
    mbid: group.mbid,
    title: group.title,
    artistCredit: group.artistName,
    primaryArtistId: group.artistCredit[0] ? artistIds.get(group.artistCredit[0].mbid)! : null,
    type: group.type,
    secondaryTypes: group.secondaryTypes,
    releaseDate: group.date,
    year: group.year,
    titleKey: matchKey(group.title),
    matchKey: creditKey(group.artistName, group.title),
    detailLevel: 1,
  })
  await replaceCredits(tx, albumArtists, id, group.artistCredit, artistIds)
  return id
}

/**
 * Keeps a store album as one edition of a release group: no MBID of its own, `edition_of_id`
 * set to the group's row, the group's type, year and credits, and as its track list the
 * MusicBrainz release `releaseMbid` when one has its track count, else the store's.
 *
 * A release the group's row had shown (written before editions were kept apart) moves here
 * and the group's row picks its own again when next opened; one that files are on stays.
 */
async function asEdition(albumId: string, group: MbReleaseGroup, releaseMbid: string | null): Promise<string> {
  const release = releaseMbid ? await musicbrainz.getRelease(releaseMbid) : null
  return db.transaction(async (tx) => {
    await lockUpserts(tx)
    const parent = await groupRow(tx, group)
    await tx.update(albums).set({ editionOfId: parent, updatedAt: new Date() }).where(eq(albums.id, albumId))
    const [filedElsewhere] = release ? await tx.execute<{ found: boolean }>(sql`
      select exists (select 1 from releases rl join media_files f on f.release_id = rl.id
        where rl.mbid = ${release.mbid} and f.album_id is distinct from ${albumId}) as found`) : []
    if (release && !filedElsewhere?.found) {
      await tx.execute(sql`
        update albums set canonical_release_id = null, detail_level = least(detail_level, 1), fetched_at = null, updated_at = now()
        where id <> ${albumId} and canonical_release_id = (select id from releases where mbid = ${release.mbid})`)
      const providerReleases = (await tx.select({ id: releases.id }).from(releases)
        .where(and(eq(releases.albumId, albumId), isNull(releases.mbid),
          sql`not exists (select 1 from media_files f where f.release_id = ${releases.id})`))).map((row) => row.id)
      const recordings = await standInsFor(tx, albumId, release)
      await upsertRelease(tx, release, { releaseIds: providerReleases, recordings }, { canonical: 'always', editionAlbumId: albumId })
      await fitStrayRecordings(tx, albumId)
    } else {
      await tx.update(albums).set({
        type: group.type, typeGuessed: false, secondaryTypes: group.secondaryTypes, year: group.year, releaseDate: group.date,
      }).where(eq(albums.id, albumId))
    }
    await tx.update(albums).set({
      genres: genreNames(group.genres), detailLevel: release ? 2 : sql`greatest(${albums.detailLevel}, 1)`, fetchedAt: new Date(), updatedAt: new Date(),
    }).where(eq(albums.id, albumId))
    return albumId
  })
}
