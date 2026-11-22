/**
 * Another cover for an album whose cover its source does not have. The art route
 * unassigns a lazy cover the source answers 404 for (a release group the Cover Art
 * Archive has no front for) and queues `enrichment.cover`, so the album shows the next
 * source that has one instead of an empty square:
 *
 * 1. the album's own files: a folder image beside a present file, or the picture embedded
 *    in one (`albumArtFromFiles`, the same choice a scan makes);
 * 2. Deezer's cover of the album's Deezer page, as a lazy remote image.
 *
 * The Cover Art Archive is not asked again for one of the group's releases: its group
 * front is the front of one of them, so a group without one has none to offer.
 *
 * The sweep also queues albums with no cover that have one of those sources, each tried
 * once a day per process, which repairs albums whose cover was unassigned before the job
 * existed.
 */
import path from 'node:path'
import { queryKeys } from '@squirmy/contracts'
import { sql } from 'drizzle-orm'
import { db } from '../../database/client.js'
import { albumArtFromFiles, assignAlbumArtwork, remoteImage } from '../artwork/index.js'
import { deezer } from '../metadata/index.js'
import { changed, currentId, day, externalIdOf } from './rows.js'

/** Albums the sweep queues per run. */
const batch = 200
const triedAt = new Map<string, number>()

/** Forgets which albums the sweep queued, for tests. */
export function resetCoverSweep() {
  triedAt.clear()
}

/** Gives an album without a cover the first source in the module comment that has one. Returns whether it got one. */
export async function fallbackCover(id: string): Promise<boolean> {
  const albumId = await currentId('album', id)
  if (!albumId) return false
  const [album] = await db.execute<{ artworkAssetId: string | null }>(sql`select artwork_asset_id as "artworkAssetId" from albums where id = ${albumId}`)
  if (!album || album.artworkAssetId) return false

  const files = await db.execute<{ root: string; relPath: string; embedded: string | null }>(sql`
    select r.path as root, f.rel_path as "relPath", f.embedded_art_asset_id as embedded
    from media_files f join library_roots r on r.id = f.root_id
    where f.album_id = ${albumId} and f.missing_since is null`)
  let assigned = files.length > 0 && await albumArtFromFiles(
    albumId,
    files.map((file) => path.join(file.root, path.posix.dirname(file.relPath))),
    files.flatMap((file) => (file.embedded ? [file.embedded] : [])),
  )

  if (!assigned) {
    const deezerId = await externalIdOf('deezer', 'album', albumId)
    const url = deezerId ? (await deezer.getAlbum(Number(deezerId)))?.coverUrl : null
    if (url) assigned = await assignAlbumArtwork(albumId, (await remoteImage(url, { kind: 'cover' })).id, { onlyIfEmpty: true })
  }
  if (assigned) await changed([queryKeys.album(albumId), queryKeys.home(), queryKeys.library()])
  return assigned
}

/**
 * Albums without a cover that have a source `fallbackCover` can use: a present file, or a
 * Deezer page. Leaves out the ones queued in the last day.
 */
export async function albumsMissingCovers(): Promise<string[]> {
  const now = Date.now()
  for (const [albumId, at] of triedAt) if (at < now - day) triedAt.delete(albumId)
  const rows = await db.execute<{ id: string }>(sql`
    select a.id from albums a
    where a.artwork_asset_id is null and a.merged_into_id is null
      and (exists (select 1 from media_files f where f.album_id = a.id and f.missing_since is null)
        or exists (select 1 from external_ids e where e.provider = 'deezer' and e.entity_type = 'album' and e.entity_id = a.id))
    order by a.id limit ${batch + triedAt.size}`)
  const picked = rows.map((row) => row.id).filter((albumId) => !triedAt.has(albumId)).slice(0, batch)
  for (const albumId of picked) triedAt.set(albumId, now)
  return picked
}
