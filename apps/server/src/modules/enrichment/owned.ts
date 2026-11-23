/**
 * The extras music the user owns gets in the background, on top of album detail: a real
 * stored cover, a description, Deezer ids for search to match against, and lyrics.
 */
import { eq, sql } from 'drizzle-orm'
import { db } from '../../database/client.js'
import { albums, assets } from '../../database/schema.js'
import { enqueueMany } from '../../jobs/index.js'
import { matchKey } from '../../lib/text.js'
import { assignAlbumArtwork, storeImage } from '../artwork/index.js'
import { canonicalRelease } from '../catalog/availability.js'
import { coverart, deezer, fetchImage, musicbrainz, wikidata } from '../metadata/index.js'
import type { DeezerAlbum } from '../metadata/deezer.js'
import { linkDeezerAlbum } from './deezer-rows.js'
import { albumDetailRun } from './detail.js'
import { albumChanged, albumOwned, attempt, currentId, externalIdOf, linkExternalId } from './rows.js'

/** Covers at least this many pixels on their short side are kept. */
const goodCoverPx = 500
/** ISRC lookups per album for recordings the album's Deezer page did not cover. */
const isrcLookups = 30

/**
 * Album detail first, then for an album with present files: the cover, a description,
 * Deezer ids, and a lyrics lookup for each owned recording without lyrics. Marks the
 * album `enriched_at` when every step succeeded.
 */
export async function enrichAlbum(id: string): Promise<void> {
  await albumDetailRun(id)
  const albumId = await currentId('album', id)
  if (!albumId || !(await albumOwned(albumId))) return
  const [album] = await db.execute<{ mbid: string | null; releaseMbid: string | null; barcode: string | null; description: string | null; genres: string[]; primaryArtistId: string | null; artistName: string | null }>(sql`
    select a.mbid, rl.mbid as "releaseMbid", rl.barcode, a.description, a.genres, a.primary_artist_id as "primaryArtistId", ar.name as "artistName"
    from albums a left join releases rl on rl.id = ${canonicalRelease('a')} left join artists ar on ar.id = a.primary_artist_id
    where a.id = ${albumId}`)
  if (!album) return

  const found: { deezer: DeezerAlbum | null } = { deezer: null }
  const steps = [
    await attempt('Deezer ids', async () => {
      found.deezer = await linkDeezer(albumId, album.barcode)
      const dz = found.deezer
      if (dz && album.primaryArtistId && album.artistName && matchKey(dz.artist.name) === matchKey(album.artistName)) {
        await linkExternalId('deezer', 'artist', String(dz.artist.id), album.primaryArtistId)
      }
    }),
    await attempt('cover', () => ownedCover(albumId, { releaseMbid: album.releaseMbid, groupMbid: album.mbid, deezerCover: found.deezer?.coverUrl ?? null })),
    await attempt('description', () => addDescription(albumId, album, found.deezer)),
  ]
  await queueLyrics(albumId)
  if (steps.every(Boolean)) await db.update(albums).set({ enrichedAt: new Date() }).where(eq(albums.id, albumId))
  await albumChanged(albumId)
}

/**
 * Links the album and its owned recordings to Deezer: the album by the id it carries or
 * its barcode (UPC), its recordings by that page's track list, and the recordings left
 * by ISRC. When neither id nor barcode finds the album, the page most of the ISRC
 * matches belong to is taken, if at least half of them agree. Returns the Deezer album.
 */
async function linkDeezer(albumId: string, barcode: string | null): Promise<DeezerAlbum | null> {
  const known = await externalIdOf('deezer', 'album', albumId)
  // Deezer keys UPC-A codes; an EAN-13 of the same product only adds a leading zero.
  const upcs = barcode ? [barcode, ...(barcode.length === 13 && barcode.startsWith('0') ? [barcode.slice(1)] : [])] : []
  let dz = known ? await deezer.getAlbum(Number(known)) : null
  for (const upc of upcs) dz ??= await deezer.getAlbumByUpc(upc)
  if (dz) await linkDeezerAlbum(albumId, dz)

  const votes = await linkTracksByIsrc(albumId)
  const [best] = [...votes].sort((a, b) => b[1] - a[1])
  const total = [...votes.values()].reduce((sum, count) => sum + count, 0)
  if (!dz && best && best[1] * 2 >= total) {
    dz = await deezer.getAlbum(best[0])
    if (dz) await linkDeezerAlbum(albumId, dz)
  }
  return dz
}

/**
 * Deezer ids by ISRC for owned recordings on the album that still have none. Returns how
 * many of the matched tracks sit on each Deezer album.
 */
async function linkTracksByIsrc(albumId: string): Promise<Map<number, number>> {
  const missing = await db.execute<{ id: string; isrc: string }>(sql`
    select distinct on (r.id) r.id, r.isrcs[1] as isrc
    from media_files f join recordings r on r.id = f.recording_id
    where f.album_id = ${albumId} and f.missing_since is null and cardinality(r.isrcs) > 0
      and not exists (select 1 from external_ids e where e.provider = 'deezer' and e.entity_type = 'recording' and e.entity_id = r.id)
    order by r.id limit ${isrcLookups}`)
  const votes = new Map<number, number>()
  for (const row of missing) {
    const track = await deezer.getTrackByIsrc(row.isrc)
    if (!track) continue
    await linkExternalId('deezer', 'recording', String(track.id), row.id)
    if (track.album) votes.set(track.album.id, (votes.get(track.album.id) ?? 0) + 1)
  }
  return votes
}

/**
 * Keeps a stored cover that is at least 500 px on its short side (folder or embedded art,
 * usually). Otherwise downloads, in order, the Cover Art Archive's release front, its
 * release-group front and Deezer's cover until one is 500 px, stores them, and uses the
 * largest when it beats what the album has.
 */
async function ownedCover(albumId: string, sources: { releaseMbid: string | null; groupMbid: string | null; deezerCover: string | null }) {
  const [current] = await db.select({ status: assets.status, width: assets.width, height: assets.height }).from(albums)
    .innerJoin(assets, eq(assets.id, albums.artworkAssetId)).where(eq(albums.id, albumId))
  const side = (asset: { width: number | null; height: number | null } | undefined) => Math.min(asset?.width ?? 0, asset?.height ?? 0)
  let best = { id: null as string | null, side: current?.status === 'ready' ? side(current) : 0 }
  if (best.side >= goodCoverPx) return

  const candidates = [
    () => (sources.releaseMbid ? coverart.getReleaseCover(sources.releaseMbid) : null),
    () => (sources.groupMbid ? coverart.getReleaseGroupCover(sources.groupMbid) : null),
    () => sources.deezerCover,
  ]
  for (const candidate of candidates) {
    if (best.side >= goodCoverPx) break
    const url = await candidate()
    const image = url ? await fetchImage(url) : null
    const asset = url && image ? await storeImage(image.bytes, { kind: 'cover', source: url }).catch(() => null) : null
    if (asset && side(asset) > best.side) best = { id: asset.id, side: side(asset) }
  }
  if (best.id) await assignAlbumArtwork(albumId, best.id, { onlyIfEmpty: false })
}

/** The English Wikipedia summary linked from the release group, and Deezer's genres when MusicBrainz has none. */
async function addDescription(albumId: string, album: { mbid: string | null; description: string | null; genres: string[] }, dz: DeezerAlbum | null) {
  const update: Partial<typeof albums.$inferInsert> = {}
  if (album.genres.length === 0 && dz && dz.genres.length > 0) update.genres = dz.genres
  if (!album.description && album.mbid) {
    const group = await musicbrainz.getReleaseGroup(album.mbid)
    const qid = group?.urls.find((link) => link.type === 'wikidata')?.url.match(/(Q\d+)$/)?.[1]
    const summary = qid ? await wikidata.getWikipediaSummary(qid) : null
    if (summary) Object.assign(update, { description: summary.text, descriptionSource: 'wikipedia' })
  }
  if (Object.keys(update).length > 0) await db.update(albums).set({ ...update, updatedAt: new Date() }).where(eq(albums.id, albumId))
}

/** Queues a lyrics lookup for each owned recording of the album that has no lyrics row. */
async function queueLyrics(albumId: string) {
  const rows = await db.execute<{ id: string }>(sql`
    select distinct f.recording_id as id from media_files f
    where f.album_id = ${albumId} and f.missing_since is null and f.recording_id is not null
      and not exists (select 1 from lyrics l where l.recording_id = f.recording_id)`)
  await enqueueMany('enrichment.lyrics', rows.map((row) => ({ data: { recordingId: row.id }, singletonKey: row.id, priority: -5 })))
}
