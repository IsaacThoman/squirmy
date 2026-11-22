/**
 * Artist detail: profile, discography, image, bio and popular tracks, from MusicBrainz
 * (with Deezer, fanart.tv, Wikidata and ListenBrainz around it), or from Deezer alone
 * for an artist MusicBrainz cannot name.
 */
import { queryKeys } from '@squirmy/contracts'
import { and, eq, isNull, sql } from 'drizzle-orm'
import { db } from '../../database/client.js'
import { albumArtists, albums, artists, recordings } from '../../database/schema.js'
import { newId } from '../../lib/ids.js'
import { getServerSettings } from '../../lib/settings.js'
import { creditKey, matchKey } from '../../lib/text.js'
import { assignAlbumArtwork, remoteImage } from '../artwork/index.js'
import { lockUpserts, replaceCredits, upsertArtists } from '../matching/apply.js'
import { resolveMerged } from '../matching/merge.js'
import { deezer, fanart, listenbrainz, musicbrainz, wikidata } from '../metadata/index.js'
import type { MbReleaseGroupSummary, MbUrl } from '../metadata/musicbrainz.js'
import { genreNames } from './album.js'
import { bridgeArtist } from './bridge.js'
import { deezerDiscography, deezerTopTrackRow } from './deezer-rows.js'
import { adoptMbidNow, attempt, changed, currentId, day, externalIdOf, linkExternalId, share } from './rows.js'

/** A complete artist is refreshed after this long. */
const refreshAfterMs = 30 * day
/** An artist only Deezer knows tries the MusicBrainz bridge again after this long. */
const bridgeRetryMs = day
const topTrackCount = 25

type ArtistRow = Pick<typeof artists.$inferSelect, 'mbid' | 'detailLevel' | 'fetchedAt'>

function fresh(artist: ArtistRow, now: number): boolean {
  const age = artist.fetchedAt ? now - artist.fetchedAt.getTime() : Infinity
  if (artist.detailLevel >= 2) return age < refreshAfterMs
  return !artist.mbid && age < bridgeRetryMs
}

/** Deezer artist ids among MusicBrainz url relations (`https://www.deezer.com/artist/399`). */
function deezerArtistIds(urls: readonly MbUrl[]): string[] {
  return [...new Set(urls.flatMap((link) => /deezer\.com\/(?:[a-z]{2}\/)?artist\/(\d+)/.exec(link.url)?.[1] ?? []))]
}

/** Of several Deezer pages for one artist (duplicates happen), the one with the most fans. */
async function mainDeezerArtist(ids: readonly string[]): Promise<string | null> {
  if (ids.length <= 1) return ids[0] ?? null
  let best: { id: string; fans: number } | null = null
  for (const id of ids) {
    const fans = (await deezer.getArtist(Number(id)))?.fans ?? -1
    if (!best || fans > best.fans) best = { id, fans }
  }
  return best!.id
}

/**
 * Brings an artist to `detail_level` 2 when its sources allow, following merges. Returns
 * the id of the row holding the artist afterwards, or null when there is no such artist.
 * A failing optional source (images, bio, top tracks) is skipped and leaves the artist
 * below level 2, so the next visit tries again.
 */
export async function hydrateArtist(id: string, { force = false } = {}): Promise<string | null> {
  const artistId = await currentId('artist', id)
  if (!artistId) return null
  const [artist] = await db.select({ mbid: artists.mbid, name: artists.name, detailLevel: artists.detailLevel, fetchedAt: artists.fetchedAt })
    .from(artists).where(eq(artists.id, artistId))
  if (!artist || (!force && fresh(artist, Date.now()))) return artistId
  let deezerId = await externalIdOf('deezer', 'artist', artistId)
  if (!artist.mbid && !deezerId) return artistId

  const mbid = artist.mbid ?? (deezerId ? await bridgeArtist(deezerId, artist.name) : null)
  const profile = mbid ? await musicbrainz.getArtist(mbid) : null
  let target = artistId
  let complete = false
  if (profile) {
    target = await adoptMbidNow('artist', artistId, profile.mbid)
    await db.update(artists).set({
      name: profile.name,
      sortName: profile.sortName,
      nameKey: matchKey(profile.name),
      disambiguation: profile.disambiguation || null,
      kind: profile.type,
      country: profile.country,
      genres: genreNames(profile.genres),
      updatedAt: new Date(),
    }).where(eq(artists.id, target))
    const linked = deezerArtistIds(profile.urls)
    for (const one of linked) await linkExternalId('deezer', 'artist', one, target)
    deezerId = linked.length > 0 ? await mainDeezerArtist(linked) : await externalIdOf('deezer', 'artist', target)

    const steps = [
      await attempt('discography', async () => upsertDiscography(await musicbrainz.browseReleaseGroups(profile.mbid, { officialOnly: true }))),
      await attempt('artist image', () => artistImage(target, { mbid: profile.mbid, wikidataId: profile.wikidataId, deezerId })),
      await attempt('bio', () => artistBio(target, profile.wikidataId)),
      await attempt('top tracks', () => topTracks(target, { mbid: profile.mbid, deezerId })),
    ]
    complete = steps.every(Boolean)
  } else if (deezerId) {
    const dz = deezerId
    await attempt('Deezer discography', () => deezerDiscography(target, dz))
    await attempt('artist image', () => artistImage(target, { mbid: null, wikidataId: null, deezerId: dz }))
    await attempt('top tracks', () => topTracks(target, { mbid: null, deezerId: dz }))
  }
  await db.update(artists).set({
    detailLevel: complete ? 2 : sql`greatest(${artists.detailLevel}, 1)`,
    fetchedAt: new Date(),
    updatedAt: new Date(),
  }).where(eq(artists.id, target))
  await changed([queryKeys.artist(target), ...(target === artistId ? [] : [queryKeys.artist(artistId)])])
  return target
}

/**
 * Upserts an album row (`detail_level` at least 1) for each release group, with its
 * credits and, while it has none, the Cover Art Archive's front cover as a lazy remote
 * image (a group without one simply 404s when shown). Rows are keyed by MBID, so running
 * it again changes nothing. Returns the ids of albums it created.
 */
export async function upsertDiscography(groups: readonly MbReleaseGroupSummary[]): Promise<string[]> {
  if (groups.length === 0) return []
  const rows = await db.transaction(async (tx) => {
    await lockUpserts(tx)
    const artistIds = await upsertArtists(tx, groups.flatMap((group) => group.artistCredit))
    const written: { id: string; mbid: string; artworkAssetId: string | null; inserted: boolean }[] = []
    for (const group of groups) {
      const values = {
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
      }
      const [row] = await tx.insert(albums).values({ id: newId(), ...values, detailLevel: 1 })
        .onConflictDoUpdate({
          target: albums.mbid,
          set: { ...values, detailLevel: sql`greatest(${albums.detailLevel}, 1)`, updatedAt: new Date() },
          setWhere: isNull(albums.mergedIntoId),
        })
        .returning({ id: albums.id, artworkAssetId: albums.artworkAssetId, inserted: sql<boolean>`(xmax = 0)` })
      if (!row) continue
      await replaceCredits(tx, albumArtists, row.id, group.artistCredit, artistIds)
      written.push({ ...row, mbid: group.mbid })
    }
    return written
  })
  if ((await getServerSettings()).coverArtArchiveEnabled) {
    for (const row of rows) {
      if (row.artworkAssetId) continue
      const asset = await remoteImage(`https://coverartarchive.org/release-group/${row.mbid}/front-500`, { kind: 'cover' })
      await assignAlbumArtwork(row.id, asset.id, { onlyIfEmpty: true })
    }
  }
  return rows.filter((row) => row.inserted).map((row) => row.id)
}

/** Keeps the image an artist has (from the user's folders, say); else Deezer's picture, fanart.tv, then Wikidata, as a lazy remote image. */
async function artistImage(artistId: string, sources: { mbid: string | null; wikidataId: string | null; deezerId: string | null }) {
  const [row] = await db.select({ imageAssetId: artists.imageAssetId }).from(artists).where(eq(artists.id, artistId))
  if (!row || row.imageAssetId) return
  const url = (sources.deezerId ? (await deezer.getArtist(Number(sources.deezerId)))?.imageUrl : null)
    ?? (sources.mbid ? (await fanart.getArtistImages(sources.mbid))?.thumbnails[0]?.replace(/^http:/, 'https:') : null)
    ?? (sources.wikidataId ? (await wikidata.getImage(sources.wikidataId))?.url : null)
  if (!url) return
  const asset = await remoteImage(url, { kind: 'artist' })
  await db.update(artists).set({ imageAssetId: asset.id, updatedAt: new Date() }).where(and(eq(artists.id, artistId), isNull(artists.imageAssetId)))
}

/** The English Wikipedia summary, with a link to the article. */
async function artistBio(artistId: string, wikidataId: string | null) {
  const summary = wikidataId ? await wikidata.getWikipediaSummary(wikidataId) : null
  if (!summary) return
  await db.update(artists).set({ bio: summary.text, bioSource: 'wikipedia', bioUrl: summary.sourceUrl, updatedAt: new Date() }).where(eq(artists.id, artistId))
}

/**
 * Stores a 0..1 popularity on the artist's most played recordings, from ListenBrainz when
 * a token is set and else from Deezer, creating stub rows for tracks the catalog lacks.
 */
async function topTracks(artistId: string, sources: { mbid: string | null; deezerId: string | null }) {
  const listened = sources.mbid ? await listenbrainz.topRecordingsForArtist(sources.mbid, { limit: topTrackCount }) : []
  if (listened.length > 0) {
    const max = Math.max(...listened.map((one) => one.listenCount))
    for (const one of listened) {
      const [inserted] = await db.insert(recordings).values({
        id: newId(),
        mbid: one.recordingMbid,
        title: one.title,
        artistCredit: one.artistName,
        primaryArtistId: artistId,
        durationMs: one.durationMs,
        titleKey: matchKey(one.title),
        matchKey: creditKey(one.artistName, one.title),
      }).onConflictDoNothing().returning({ id: recordings.id })
      const [existing] = inserted ? [inserted] : await db.select({ id: recordings.id }).from(recordings).where(eq(recordings.mbid, one.recordingMbid))
      const id = await resolveMerged(db, recordings, existing!.id)
      await db.update(recordings).set({ popularity: share(one.listenCount, max) }).where(eq(recordings.id, id))
    }
    return
  }
  if (!sources.deezerId) return
  const top = await deezer.getArtistTopTracks(Number(sources.deezerId), { limit: topTrackCount })
  const max = Math.max(0, ...top.map((track) => track.rank ?? 0))
  for (const [index, track] of top.entries()) {
    const id = await deezerTopTrackRow(artistId, sources.deezerId, track)
    const popularity = track.rank ? share(track.rank, max) : share(top.length - index, top.length)
    await db.update(recordings).set({ popularity }).where(eq(recordings.id, id))
  }
}
