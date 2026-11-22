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
import { guessAlbumType, releaseKey } from '../search/keys.js'
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

/**
 * The artist row for a Deezer artist: the one carrying its id, else the only artist of that
 * name when it has no Deezer id yet (as search decides, materialize.ts), else a new stub. A
 * featured artist on a top track used to become a second row beside the MusicBrainz row
 * the discography had just credited.
 */
async function deezerArtistRow(tx: Transaction, artist: DeezerArtistRef): Promise<string> {
  const existing = await linked(tx, 'artist', artist.id)
  if (existing) return existing
  const named = await tx.execute<{ id: string; hasDeezerId: boolean }>(sql`
    select a.id, exists (select 1 from external_ids e where e.provider = 'deezer' and e.entity_type = 'artist' and e.entity_id = a.id) as "hasDeezerId"
    from artists a where a.name_key = ${matchKey(artist.name)} and a.merged_into_id is null
    limit 2`)
  if (named.length === 1 && !named[0]!.hasDeezerId) {
    await tx.insert(externalIds).values({ provider: 'deezer', entityType: 'artist', externalId: String(artist.id), entityId: named[0]!.id }).onConflictDoNothing()
    return named[0]!.id
  }
  const id = newId()
  await tx.insert(artists).values({ id, name: artist.name, sortName: artist.name, nameKey: matchKey(artist.name), detailLevel: 0 })
  await tx.insert(externalIds).values({ provider: 'deezer', entityType: 'artist', externalId: String(artist.id), entityId: id })
  return id
}

/**
 * The recording row for a Deezer track: the one carrying its id, else the one recording
 * with its ISRC (the same sound on another edition, or MusicBrainz's row), else a new
 * provider-only row with its credits. A deluxe edition's track list then shares the
 * standard songs' rows instead of listing each song twice. A known row learns Deezer's
 * explicit flag when it has none.
 */
async function deezerRecordingRow(tx: Transaction, track: DeezerTrack, artistRow: (artist: DeezerArtistRef) => Promise<string>): Promise<string> {
  const isrc = track.isrc?.toUpperCase()
  let existing = await linked(tx, 'recording', track.id)
  if (!existing && isrc) {
    const same = await tx.execute<{ id: string }>(sql`
      select r.id from recordings r where r.isrcs @> array[${isrc}]::text[] and r.merged_into_id is null
      order by exists (select 1 from media_files f where f.recording_id = r.id and f.missing_since is null) desc, r.mbid is not null desc, r.id
      limit 2`)
    // Two rows with one ISRC are already a muddle (a re-release counted as a new
    // recording); a third would not help, but neither would guessing between them.
    if (same.length === 1) {
      existing = same[0]!.id
      await tx.insert(externalIds).values({ provider: 'deezer', entityType: 'recording', externalId: String(track.id), entityId: existing }).onConflictDoNothing()
    }
  }
  if (existing) {
    await tx.update(recordings).set({ explicit: track.explicit }).where(and(eq(recordings.id, existing), isNull(recordings.explicit)))
    return existing
  }
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
    const [row] = await tx.select({ primaryArtistId: albums.primaryArtistId, genres: albums.genres, mbid: albums.mbid, title: albums.title })
      .from(albums).where(eq(albums.id, albumId))
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

    // A collaboration ("Watch the Throne") credits every main artist Deezer lists, not only
    // the one search saw. MusicBrainz's credits stand once the album has its id.
    if (!row.mbid && album.artists.length > 1) {
      const credited = []
      for (const artist of album.artists) credited.push({ artist, id: await artistRow(artist) })
      const artistCredit = album.artists.map((artist) => artist.name).join(', ')
      await tx.delete(albumArtists).where(eq(albumArtists.albumId, albumId))
      await tx.insert(albumArtists).values(credited.map((one, position) => ({
        albumId, position, artistId: one.id, creditedName: one.artist.name, joinPhrase: position < credited.length - 1 ? ', ' : '',
      })))
      await tx.update(albums).set({ artistCredit, matchKey: creditKey(artistCredit, row.title) }).where(eq(albums.id, albumId))
    }

    // A row known only from a track's album reference takes the type and date Deezer states.
    const guessed = sql`(${albums.typeGuessed} and ${albums.mbid} is null)`
    await tx.update(albums).set({
      canonicalReleaseId: sql`coalesce(${albums.canonicalReleaseId}, ${releaseId}::uuid)`,
      type: sql`case when ${guessed} then ${album.type} else ${albums.type} end`,
      typeGuessed: sql`${albums.typeGuessed} and not ${guessed}`,
      releaseDate: sql`coalesce(${albums.releaseDate}, ${album.releaseDate}::text)`,
      year: sql`coalesce(${albums.year}, ${album.releaseDate ? Number(album.releaseDate.slice(0, 4)) : null}::int)`,
      genres: row.genres.length > 0 ? row.genres : album.genres,
      detailLevel: sql`greatest(${albums.detailLevel}, 1)`,
      fetchedAt: now,
      updatedAt: now,
    }).where(eq(albums.id, albumId))
  })
}

/**
 * Credits the featured artists of a Deezer-built track list. Deezer's album track list
 * names only each track's main artist ("Hurricane" without The Weeknd and Lil Baby), so
 * each track is looked up on its own. Only recordings without an MBID change: MusicBrainz
 * credits stand. Returns how many recordings gained artists.
 */
export async function creditDeezerTracks(album: DeezerAlbum): Promise<number> {
  let credited = 0
  for (const listed of album.tracks) {
    const recordingId = await db.transaction((tx) => linked(tx, 'recording', listed.id))
    if (!recordingId) continue
    const [row] = await db.execute<{ mbid: string | null; title: string; credits: number }>(sql`
      select r.mbid, r.title, (select count(*)::int from recording_artists ra where ra.recording_id = r.id) as credits
      from recordings r where r.id = ${recordingId}`)
    if (!row || row.mbid) continue
    const track = await deezer.getTrack(listed.id)
    if (!track || track.artists.length <= row.credits) continue
    await db.transaction(async (tx) => {
      await lockUpserts(tx)
      const ids: string[] = []
      for (const artist of track.artists) ids.push(await deezerArtistRow(tx, artist))
      const artistCredit = track.artists.map((artist) => artist.name).join(', ')
      await tx.delete(recordingArtists).where(eq(recordingArtists.recordingId, recordingId))
      await tx.insert(recordingArtists).values(track.artists.map((artist, position) => ({
        recordingId, position, artistId: ids[position]!, creditedName: artist.name, joinPhrase: position < track.artists.length - 1 ? ', ' : '',
      })))
      await tx.update(recordings).set({ artistCredit, matchKey: creditKey(artistCredit, row.title), updatedAt: new Date() }).where(eq(recordings.id, recordingId))
      await tx.update(releaseTracks).set({ artistCredit }).where(and(eq(releaseTracks.recordingId, recordingId), eq(releaseTracks.title, row.title)))
    })
    credited++
  }
  return credited
}

/**
 * Records the Deezer ids of an album and of the recordings on its canonical release,
 * matched by ISRC, else by position and title, and Deezer's explicit flag on recordings
 * that have none, when matched by ISRC or the album is Deezer's explicit version. A search stub that already carries one of
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
    const byIsrc = isrc ? tracks.find((row) => row.isrcs.includes(isrc)) : undefined
    const match = byIsrc
      ?? tracks.find((row) => row.disc === (track.discNumber ?? 1) && row.position === (track.trackNumber ?? index + 1) && row.titleKey === matchKey(track.title))
    if (!match) continue
    await linkExternalId('deezer', 'recording', String(track.id), match.id)
    // MusicBrainz has no explicit flag. Deezer's holds for the same sound: the same ISRC,
    // or the same place on the album's explicit version; a clean edit at that place is
    // another recording.
    if (byIsrc || album.explicit) {
      await db.update(recordings).set({ explicit: track.explicit }).where(and(eq(recordings.id, match.id), isNull(recordings.explicit)))
    }
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
 * The album row for the album a Deezer track names (no type, no date): the row carrying its
 * Deezer id, else the album artist's row of the same release (`releaseKey`), owned and
 * MusicBrainz-backed first, else a stub with the track's cover and a guessed type. Without
 * it a popular track that MusicBrainz has no release for showed no artwork.
 */
async function deezerTrackAlbumRow(tx: Transaction, albumArtistId: string, credit: string, track: DeezerTrack, coverId: string | null): Promise<string | null> {
  const album = track.album
  if (!album) return null
  const existing = await linked(tx, 'album', album.id)
  if (existing) return existing
  const key = releaseKey(album.title)
  const type = guessAlbumType(album.title, [track.title])
  const rows = await tx.execute<{ id: string; title: string; type: string }>(sql`
    select a.id, a.title, a.type from albums a
    where a.primary_artist_id = ${albumArtistId} and a.merged_into_id is null
    order by exists (select 1 from media_files f where f.album_id = a.id and f.missing_since is null) desc,
      a.mbid is not null desc, (a.type = ${type}) desc, a.detail_level desc, a.id`)
  const same = rows.find((row) => releaseKey(row.title) === key)
  const id = same?.id ?? newId()
  if (!same) {
    await tx.insert(albums).values({
      id,
      title: album.title,
      artistCredit: credit,
      primaryArtistId: albumArtistId,
      type,
      typeGuessed: true,
      titleKey: matchKey(album.title),
      matchKey: creditKey(credit, album.title),
      artworkAssetId: coverId,
      detailLevel: 0,
    })
    await tx.insert(albumArtists).values({ albumId: id, position: 0, artistId: albumArtistId, creditedName: credit })
  } else if (coverId) {
    await tx.update(albums).set({ artworkAssetId: coverId }).where(and(eq(albums.id, id), isNull(albums.artworkAssetId)))
  }
  await tx.insert(externalIds).values({ provider: 'deezer', entityType: 'album', externalId: String(album.id), entityId: id }).onConflictDoNothing()
  return id
}

/**
 * Finds or creates the row for one of an artist's popular Deezer tracks, with the album
 * Deezer names for it as its album hint (when it is on no release yet), so it has artwork.
 * `deezerArtistId` is the page artist's Deezer id: a top track may be another artist's with
 * this one featured, and only this artist's own credit is `artistId`.
 */
export async function deezerTopTrackRow(artistId: string, deezerArtistId: string, track: DeezerTrack): Promise<string> {
  // Registered before the transaction, like search does: no network while holding the lock.
  const cover = track.album?.coverUrl ? await remoteImage(track.album.coverUrl, { kind: 'cover' }) : null
  return db.transaction(async (tx) => {
    await lockUpserts(tx)
    const artistRow = async (artist: DeezerArtistRef) => (String(artist.id) === deezerArtistId ? artistId : deezerArtistRow(tx, artist))
    const recordingId = await topTrackRecording(tx, artistId, track, artistRow)
    const albumId = await deezerTrackAlbumRow(tx, await artistRow(track.artist), track.artist.name, track, cover?.id ?? null)
    if (albumId) {
      await tx.execute(sql`
        update recordings r set album_hint_id = ${albumId}
        where r.id = ${recordingId} and r.album_hint_id is null
          and not exists (select 1 from release_tracks rt where rt.recording_id = r.id)`)
    }
    return recordingId
  })
}

/**
 * Finds or creates the row for a track of an artist's Deezer radio, which is mostly other
 * artists' tracks: the row of its own artist (as `deezerArtistRow` decides), then the track
 * as one of that artist's popular tracks, so the same Deezer track maps to the same row
 * whichever page or radio wrote it first.
 */
export async function deezerRadioTrackRow(track: DeezerTrack): Promise<string> {
  const artistId = await db.transaction(async (tx) => {
    await lockUpserts(tx)
    return deezerArtistRow(tx, track.artist)
  })
  return deezerTopTrackRow(artistId, String(track.artist.id), track)
}

async function topTrackRecording(tx: Transaction, artistId: string, track: DeezerTrack, artistRow: (artist: DeezerArtistRef) => Promise<string>): Promise<string> {
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
  return deezerRecordingRow(tx, track, artistRow)
}
