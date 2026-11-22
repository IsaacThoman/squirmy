/**
 * Album detail: a canonical MusicBrainz release with its full track list, reached from a
 * release-group MBID or bridged from a Deezer id, and a Deezer track list when there is
 * no MusicBrainz match.
 */
import { queryKeys, type AlbumType } from '@squirmy/contracts'
import { and, eq, isNull, sql } from 'drizzle-orm'
import { db, type Executor } from '../../database/client.js'
import { albums, releases } from '../../database/schema.js'
import { lockUpserts, upsertRelease } from '../matching/apply.js'
import { mergeAlbum } from '../matching/merge.js'
import { deezer, musicbrainz } from '../metadata/index.js'
import type { DeezerAlbum } from '../metadata/deezer.js'
import type { MbReleaseGroup } from '../metadata/musicbrainz.js'
import { bridgeAlbum } from './bridge.js'
import { chooseCanonicalRelease } from './canonical.js'
import { buildFromDeezer, linkDeezerAlbum } from './deezer-rows.js'
import { fitStrayRecordings } from './fit.js'
import { adoptMbid, albumOwned, attempt, changed, currentId, day, externalIdOf } from './rows.js'

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
  }).from(albums).leftJoin(releases, eq(releases.id, albums.canonicalReleaseId)).where(eq(albums.id, albumId))
  if (!album || (!force && fresh(album, Date.now()))) return albumId

  const deezerId = await externalIdOf('deezer', 'album', albumId)
  if (!album.mbid && !deezerId) return albumId
  let dz: DeezerAlbum | null | undefined
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
  const groupMbid = album.mbid ?? (deezerId ? await bridgeAlbum(deezerId, { title: album.title, artist: album.artistCredit, type: album.type as AlbumType }) : null)
  let result = albumId
  if (groupMbid) {
    const group = await musicbrainz.getReleaseGroup(groupMbid)
    if (group) result = await fromMusicBrainz(albumId, group)
  }
  const [after] = await db.select({ detailLevel: albums.detailLevel }).from(albums).where(eq(albums.id, result))
  if (dz === undefined) dz = deezerId ? await deezer.getAlbum(Number(deezerId)) : null
  if (dz && (after?.detailLevel ?? 0) < 2) await buildFromDeezer(result, dz)
  if (dz) await linkDeezerAlbum(result, dz)
  await changed([queryKeys.album(result), ...(result === albumId ? [] : [queryKeys.album(albumId)])])
  return result
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
 */
async function fromMusicBrainz(albumId: string, group: MbReleaseGroup): Promise<string> {
  const chosen = (await keepsCanonical(albumId)) ? null : chooseCanonicalRelease(group.releases)
  const release = chosen ? await musicbrainz.getRelease(chosen.mbid) : null
  return db.transaction(async (tx) => {
    await lockUpserts(tx)
    let target = await adoptMbid(tx, 'album', albumId, group.mbid)
    if (release && !(await keepsCanonical(target, tx))) {
      // A track list built from Deezer becomes this release; an edition files are on stays.
      const providerReleases = (await tx.select({ id: releases.id }).from(releases)
        .where(and(eq(releases.albumId, target), isNull(releases.mbid),
          sql`not exists (select 1 from media_files f where f.release_id = ${releases.id})`))).map((row) => row.id)
      const upserted = await upsertRelease(tx, release, { releaseIds: providerReleases }, { canonical: 'always' })
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
