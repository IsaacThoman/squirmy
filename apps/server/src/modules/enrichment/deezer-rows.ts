/**
 * Catalog rows built from Deezer for music MusicBrainz does not know (yet), and the
 * Deezer ids of rows it does. Provider-only rows have no MBID; each carries its Deezer id
 * in `external_ids`, so a later bridge or a search result finds the same row.
 */
import { and, asc, eq, isNull, notInArray, sql } from 'drizzle-orm'
import { db, type Transaction } from '../../database/client.js'
import { albumArtists, albums, artists, externalIds, recordingArtists, recordings, releases, releaseTracks } from '../../database/schema.js'
import { newId } from '../../lib/ids.js'
import { creditKey, matchKey } from '../../lib/text.js'
import { remoteImage } from '../artwork/index.js'
import { canonicalRelease } from '../catalog/availability.js'
import { lockUpserts } from '../matching/apply.js'
import { resolveMerged } from '../matching/merge.js'
import { deezer } from '../metadata/index.js'
import type { DeezerAlbum, DeezerTrack } from '../metadata/deezer.js'
import { linkExternalId } from './rows.js'

type DeezerArtistRef = { id: number; name: string }

async function linked(tx: Transaction, type: 'artist' | 'album' | 'recording', id: number): Promise<string | null> {
  const [row] = await tx.select({ id: externalIds.entityId }).from(externalIds)
    .where(and(eq(externalIds.provider, 'deezer'), eq(externalIds.entityType, type), eq(externalIds.externalId, String(id))))
  if (!row) return null
  const table = type === 'artist' ? artists : type === 'album' ? albums : recordings
  return resolveMerged(tx, table, row.id)
}

/** The artist row for a Deezer artist: the one carrying its id, else a new stub. */
async function deezerArtistRow(tx: Transaction, artist: DeezerArtistRef): Promise<string> {
  const existing = await linked(tx, 'artist', artist.id)
  if (existing) return existing
  const id = newId()
  await tx.insert(artists).values({ id, name: artist.name, sortName: artist.name, nameKey: matchKey(artist.name), detailLevel: 0 })
  await tx.insert(externalIds).values({ provider: 'deezer', entityType: 'artist', externalId: String(artist.id), entityId: id })
  return id
}

/** The recording row for a Deezer track: the one carrying its id, else a new provider-only row with its credits. */
async function deezerRecordingRow(tx: Transaction, track: DeezerTrack, artistRow: (artist: DeezerArtistRef) => Promise<string>): Promise<string> {
  const existing = await linked(tx, 'recording', track.id)
  if (existing) return existing
  const credited = track.artists.length > 0 ? track.artists : [track.artist]
  const artistCredit = credited.map((artist) => artist.name).join(', ')
  const id = newId()
  await tx.insert(recordings).values({
    id,
    title: track.title,
    artistCredit,
    primaryArtistId: await artistRow(track.artist),
    durationMs: track.durationMs || null,
    isrcs: track.isrc ? [track.isrc.toUpperCase()] : [],
    titleKey: matchKey(track.title),
    matchKey: creditKey(artistCredit, track.title),
    explicit: track.explicit,
  })
  for (const [position, artist] of credited.entries()) {
    await tx.insert(recordingArtists).values({
      recordingId: id, position, artistId: await artistRow(artist), creditedName: artist.name, joinPhrase: position < credited.length - 1 ? ', ' : '',
    })
  }
  await tx.insert(externalIds).values({ provider: 'deezer', entityType: 'recording', externalId: String(track.id), entityId: id })
  return id
}

/**
 * Gives an album without a MusicBrainz match a track list from Deezer: one provider-only
 * release (reused on later runs) with a provider-only recording per track, carrying
 * Deezer's ISRCs. It becomes the canonical release unless the album has another one.
 * The album stays at `detail_level` 1, so a later run tries the MusicBrainz bridge again.
 */
export async function buildFromDeezer(albumId: string, album: DeezerAlbum): Promise<void> {
  await db.transaction(async (tx) => {
    await lockUpserts(tx)
    const [row] = await tx.select({ primaryArtistId: albums.primaryArtistId, genres: albums.genres }).from(albums).where(eq(albums.id, albumId))
    if (!row) return
    const artistIds = new Map<number, string>()
    if (row.primaryArtistId) artistIds.set(album.artist.id, row.primaryArtistId)
    const artistRow = async (artist: DeezerArtistRef) => {
      let id = artistIds.get(artist.id)
      if (!id) {
        id = await deezerArtistRow(tx, artist)
        artistIds.set(artist.id, id)
      }
      return id
    }

    const now = new Date()
    const values = {
      albumId,
      title: album.title,
      releaseDate: album.releaseDate,
      label: album.label,
      barcode: album.upc,
      format: 'Digital Media',
      trackCount: album.tracks.length,
      discCount: Math.max(1, ...album.tracks.map((track) => track.discNumber ?? 1)),
      detailLevel: 1,
      fetchedAt: now,
      updatedAt: now,
    }
    const [existing] = await tx.select({ id: releases.id }).from(releases)
      .where(and(eq(releases.albumId, albumId), isNull(releases.mbid))).orderBy(asc(releases.createdAt)).limit(1)
    const releaseId = existing?.id ?? newId()
    if (existing) await tx.update(releases).set(values).where(eq(releases.id, releaseId))
    else await tx.insert(releases).values({ id: releaseId, ...values })

    const kept: string[] = []
    for (const [index, track] of album.tracks.entries()) {
      const recordingId = await deezerRecordingRow(tx, track, artistRow)
      const trackValues = { recordingId, title: track.title, artistCredit: track.artists.map((artist) => artist.name).join(', ') || track.artist.name, durationMs: track.durationMs || null }
      const [written] = await tx.insert(releaseTracks)
        .values({ id: newId(), releaseId, disc: track.discNumber ?? 1, position: track.trackNumber ?? index + 1, ...trackValues })
        .onConflictDoUpdate({ target: [releaseTracks.releaseId, releaseTracks.disc, releaseTracks.position], set: trackValues })
        .returning({ id: releaseTracks.id })
      kept.push(written!.id)
    }
    if (kept.length > 0) await tx.delete(releaseTracks).where(and(eq(releaseTracks.releaseId, releaseId), notInArray(releaseTracks.id, kept)))

    await tx.update(albums).set({
      canonicalReleaseId: sql`coalesce(${albums.canonicalReleaseId}, ${releaseId}::uuid)`,
      genres: row.genres.length > 0 ? row.genres : album.genres,
      detailLevel: sql`greatest(${albums.detailLevel}, 1)`,
      fetchedAt: now,
      updatedAt: now,
    }).where(eq(albums.id, albumId))
  })
}

/**
 * Records the Deezer ids of an album and of the recordings on its canonical release,
 * matched by ISRC, else by position and title. A search stub that already carries one of
 * those ids is merged into the catalog row.
 */
export async function linkDeezerAlbum(albumId: string, album: DeezerAlbum): Promise<void> {
  await linkExternalId('deezer', 'album', String(album.id), albumId)
  const tracks = await db.execute<{ id: string; disc: number; position: number; titleKey: string; isrcs: string[] }>(sql`
    select r.id, rt.disc, rt.position, r.title_key as "titleKey", r.isrcs
    from albums a join release_tracks rt on rt.release_id = ${canonicalRelease('a')} join recordings r on r.id = rt.recording_id
    where a.id = ${albumId}`)
  for (const [index, track] of album.tracks.entries()) {
    const isrc = track.isrc?.toUpperCase()
    const match = (isrc ? tracks.find((row) => row.isrcs.includes(isrc)) : undefined)
      ?? tracks.find((row) => row.disc === (track.discNumber ?? 1) && row.position === (track.trackNumber ?? index + 1) && row.titleKey === matchKey(track.title))
    if (match) await linkExternalId('deezer', 'recording', String(track.id), match.id)
  }
}

/**
 * Album stubs for a Deezer artist's albums, EPs and singles that no row carries yet, each
 * with its cover as a lazy remote image. For artists MusicBrainz cannot name.
 */
export async function deezerDiscography(artistId: string, deezerArtistId: string): Promise<void> {
  const [artist] = await db.select({ name: artists.name }).from(artists).where(eq(artists.id, artistId))
  if (!artist) return
  for (const album of await deezer.getArtistAlbums(Number(deezerArtistId))) {
    const artwork = album.coverUrl ? await remoteImage(album.coverUrl, { kind: 'cover' }) : null
    await db.transaction(async (tx) => {
      await lockUpserts(tx)
      if (await linked(tx, 'album', album.id)) return
      const credit = album.artist.name || artist.name
      const id = newId()
      await tx.insert(albums).values({
        id,
        title: album.title,
        artistCredit: credit,
        primaryArtistId: artistId,
        type: album.type,
        releaseDate: album.releaseDate,
        year: album.releaseDate ? Number(album.releaseDate.slice(0, 4)) : null,
        titleKey: matchKey(album.title),
        matchKey: creditKey(credit, album.title),
        artworkAssetId: artwork?.id ?? null,
        detailLevel: 0,
      })
      await tx.insert(albumArtists).values({ albumId: id, position: 0, artistId, creditedName: credit })
      await tx.insert(externalIds).values({ provider: 'deezer', entityType: 'album', externalId: String(album.id), entityId: id })
    })
  }
}

/**
 * Finds or creates the row for one of an artist's popular Deezer tracks. `deezerArtistId`
 * is the page artist's Deezer id: a top track may be another artist's with this one
 * featured, and only this artist's own credit is `artistId`.
 */
export async function deezerTopTrackRow(artistId: string, deezerArtistId: string, track: DeezerTrack): Promise<string> {
  return db.transaction(async (tx) => {
    await lockUpserts(tx)
    const existing = await linked(tx, 'recording', track.id)
    if (existing) return existing
    const isrc = track.isrc?.toUpperCase()
    // A catalog recording with the ISRC, else one of the artist's with the same credit and
    // title: owned first, then MusicBrainz-backed, so the copy the page shows gets ranked.
    const hasIsrc = isrc ? sql`r.isrcs @> array[${isrc}]::text[]` : null
    const [known] = await tx.execute<{ id: string }>(sql`
      select r.id from recordings r
      where r.merged_into_id is null
        and (${hasIsrc ?? sql`false`} or (r.primary_artist_id = ${artistId} and r.match_key = ${creditKey(track.artist.name, track.title)}))
      order by ${hasIsrc ? sql`${hasIsrc} desc,` : sql``}
        exists (select 1 from media_files f where f.recording_id = r.id and f.missing_since is null) desc,
        r.mbid is not null desc, r.id
      limit 1`)
    if (known) {
      await tx.insert(externalIds).values({ provider: 'deezer', entityType: 'recording', externalId: String(track.id), entityId: known.id }).onConflictDoNothing()
      return known.id
    }
    return deezerRecordingRow(tx, track, async (artist) => (String(artist.id) === deezerArtistId ? artistId : deezerArtistRow(tx, artist)))
  })
}
