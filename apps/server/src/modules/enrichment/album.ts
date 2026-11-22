/**
 * Album detail: a canonical MusicBrainz release with its full track list, reached from a
 * release-group MBID or bridged from a Deezer id, and a Deezer track list when there is
 * no MusicBrainz match.
 */
import { queryKeys, type AlbumType } from '@squirmy/contracts'
import { and, eq, isNull } from 'drizzle-orm'
import { db } from '../../database/client.js'
import { albums, releases } from '../../database/schema.js'
import { lockUpserts, upsertRelease } from '../matching/apply.js'
import { mergeAlbum } from '../matching/merge.js'
import { deezer, musicbrainz } from '../metadata/index.js'
import type { MbReleaseGroup } from '../metadata/musicbrainz.js'
import { bridgeAlbum } from './bridge.js'
import { chooseCanonicalRelease } from './canonical.js'
import { buildFromDeezer, linkDeezerAlbum } from './deezer-rows.js'
import { fitStrayRecordings } from './fit.js'
import { adoptMbid, albumOwned, changed, currentId, day, externalIdOf } from './rows.js'

/** A complete album is refreshed after this long. */
const refreshAfterMs = 30 * day
/** An album built from Deezer tries the MusicBrainz bridge again after this long. */
const bridgeRetryMs = day
const maxGenres = 5

type AlbumRow = Pick<typeof albums.$inferSelect, 'id' | 'mbid' | 'title' | 'artistCredit' | 'type' | 'detailLevel' | 'fetchedAt' | 'canonicalReleaseId'>

/** Whether the album is as complete as a recent run could make it. */
function fresh(album: AlbumRow, now: number): boolean {
  const age = album.fetchedAt ? now - album.fetchedAt.getTime() : Infinity
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
export async function hydrateAlbum(id: string, { force = false } = {}): Promise<string | null> {
  const albumId = await currentId('album', id)
  if (!albumId) return null
  const [album] = await db.select({
    id: albums.id, mbid: albums.mbid, title: albums.title, artistCredit: albums.artistCredit, type: albums.type,
    detailLevel: albums.detailLevel, fetchedAt: albums.fetchedAt, canonicalReleaseId: albums.canonicalReleaseId,
  }).from(albums).where(eq(albums.id, albumId))
  if (!album || (!force && fresh(album, Date.now()))) return albumId

  const deezerId = await externalIdOf('deezer', 'album', albumId)
  if (!album.mbid && !deezerId) return albumId
  const groupMbid = album.mbid ?? (deezerId ? await bridgeAlbum(deezerId, { title: album.title, artist: album.artistCredit, type: album.type as AlbumType }) : null)
  let result = albumId
  if (groupMbid) {
    const group = await musicbrainz.getReleaseGroup(groupMbid)
    if (group) result = await fromMusicBrainz(albumId, group)
  }
  const [after] = await db.select({ detailLevel: albums.detailLevel }).from(albums).where(eq(albums.id, result))
  const dz = deezerId ? await deezer.getAlbum(Number(deezerId)) : null
  if (dz && (after?.detailLevel ?? 0) < 2) await buildFromDeezer(result, dz)
  if (dz) await linkDeezerAlbum(result, dz)
  await changed([queryKeys.album(result), ...(result === albumId ? [] : [queryKeys.album(albumId)])])
  return result
}

/**
 * Writes the group's canonical release under the album row, merging the row into the
 * group's own row when one exists (a bridged stub) or MusicBrainz answered with another
 * id (a merge on their side), then folds recordings that stood in for its tracks into
 * them (`fit.ts`). An album with files keeps its releases as they are.
 */
async function fromMusicBrainz(albumId: string, group: MbReleaseGroup): Promise<string> {
  const chosen = (await albumOwned(albumId)) ? null : chooseCanonicalRelease(group.releases)
  const release = chosen ? await musicbrainz.getRelease(chosen.mbid) : null
  return db.transaction(async (tx) => {
    await lockUpserts(tx)
    let target = await adoptMbid(tx, 'album', albumId, group.mbid)
    if (release && !(await albumOwned(target, tx))) {
      // A track list built from Deezer becomes this release.
      const providerReleases = (await tx.select({ id: releases.id }).from(releases)
        .where(and(eq(releases.albumId, target), isNull(releases.mbid)))).map((row) => row.id)
      const upserted = await upsertRelease(tx, release, { releaseIds: providerReleases }, { canonical: 'unless-owned' })
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
