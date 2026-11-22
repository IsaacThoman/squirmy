/**
 * Artist detail: profile, discography, image, bio and popular tracks, from MusicBrainz
 * (with Deezer, fanart.tv, Wikidata and ListenBrainz around it), or from Deezer alone
 * for an artist MusicBrainz cannot name.
 */
import { setTimeout as sleep } from 'node:timers/promises'
import { queryKeys } from '@squirmy/contracts'
import { and, eq, isNull, sql } from 'drizzle-orm'
import { db, type Transaction } from '../../database/client.js'
import { albumArtists, albums, artistTopTracks, artists, recordings } from '../../database/schema.js'
import { newId } from '../../lib/ids.js'
import { getServerSettings } from '../../lib/settings.js'
import { creditKey, matchKey } from '../../lib/text.js'
import { assignAlbumArtwork, remoteImage } from '../artwork/index.js'
import { lockUpserts, replaceCredits, upsertArtists } from '../matching/apply.js'
import { uuidArray } from '../catalog/sql.js'
import { mergeAlbum, resolveMerged } from '../matching/merge.js'
import { deezer, fanart, listenbrainz, musicbrainz, wikidata } from '../metadata/index.js'
import type { MbArtist, MbReleaseGroupSummary, MbUrl } from '../metadata/musicbrainz.js'
import { releaseKey } from '../search/keys.js'
import { genreNames } from './album.js'
import { bridgeArtist } from './bridge.js'
import { deezerDiscography, deezerTopTrackRow, detachDeezerArtist } from './deezer-rows.js'
import { reconcileArtistAlbums } from './reconcile.js'
import { adoptMbidNow, attempt, changed, currentId, day, linkExternalId, share } from './rows.js'
import { warn } from './runner.js'

/** A complete artist is refreshed after this long. */
const refreshAfterMs = 30 * day
/** An artist only Deezer knows tries the MusicBrainz bridge again after this long. */
const bridgeRetryMs = day
const topTrackCount = 25
/** A release-group cover the archive did not have is offered again after this long. */
const coverRetryMs = 7 * day
/**
 * How long the quick Deezer pass waits for the MusicBrainz profile, which names the
 * artist's own Deezer pages, before going ahead with the page the row has. MusicBrainz
 * answers within a second when it is not busy.
 */
const profileWaitMs = 1500
/** Albums the quick Deezer pass lists, newest first (Deezer credits Bach with thousands); a page waits for them. */
const quickDeezerAlbums = 200
/** Albums listed for an artist only Deezer knows, which is then the whole discography. */
const deezerOnlyAlbums = 1000
/** While a discography comes in a page at a time, open pages are told at most this often. */
const publishEveryMs = 15_000

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

async function deezerIdsOf(artistId: string): Promise<string[]> {
  const rows = await db.execute<{ id: string }>(sql`
    select external_id as id from external_ids where provider = 'deezer' and entity_type = 'artist' and entity_id = ${artistId} order by external_id`)
  return rows.map((row) => row.id)
}

/**
 * The name the artist page shows. MusicBrainz's spelling when it is only another spelling
 * of the name the row has ("JAŸ-Z" and "JAY‐Z"); the row's name when MusicBrainz lists it
 * as one of the artist's names ("Kanye West" for Ye, "Hikaru Utada" for 宇多田ヒカル),
 * which is the name the user searched, the stores show and releases credit; else
 * MusicBrainz's. A page used to change its title under the user once enrichment landed.
 */
export function displayName(current: string, profile: Pick<MbArtist, 'name' | 'aliases'>): string {
  const key = matchKey(current)
  if (key === matchKey(profile.name)) return profile.name
  return profile.aliases.some((alias) => matchKey(alias.name) === key) ? current : profile.name
}

/** Lets a page render what a run wrote so far, once; later calls do nothing. */
function once(usable: (() => void) | undefined): () => void {
  let called = false
  return () => {
    if (called) return
    called = true
    usable?.()
  }
}

/**
 * Brings an artist to `detail_level` 2 when its sources allow, following merges. Returns
 * the id of the row holding the artist afterwards, or null when there is no such artist.
 * A failing optional source (images, bio, top tracks) is skipped and leaves the artist
 * below level 2, so the next visit tries again.
 *
 * A page waits for this at most a few seconds (runner.ts), and MusicBrainz answers a
 * request a second, a big discography many pages. So the run writes in the order a page
 * can use it, and calls `usable` once there is something worth showing:
 * 1. Deezer's discography of the artist's page, which has dates and types, along with the
 *    MusicBrainz profile. That is the first answer (`usable`).
 * 2. The profile, image, bio and popular tracks.
 * 3. MusicBrainz's discography, written and announced page by page as it comes in.
 */
export async function hydrateArtist(id: string, { force = false, usable }: { force?: boolean; usable?: () => void } = {}): Promise<string | null> {
  const artistId = await currentId('artist', id)
  if (!artistId) return null
  const [artist] = await db.select({ mbid: artists.mbid, name: artists.name, detailLevel: artists.detailLevel, fetchedAt: artists.fetchedAt })
    .from(artists).where(eq(artists.id, artistId))
  if (!artist || (!force && fresh(artist, Date.now()))) return artistId
  const rowDeezerIds = await deezerIdsOf(artistId)
  if (!artist.mbid && rowDeezerIds.length === 0) return artistId
  const ready = once(usable)
  // Various Artists and the other placeholders have no discography or popular tracks of
  // their own: every compilation is credited to them (hundreds of thousands of rows), and
  // their Wikipedia article is about compilation albums.
  const placeholder = Boolean(artist.mbid && musicbrainz.specialPurposeArtists.has(artist.mbid))

  // Reading only, so it can run beside the Deezer pass; rows change once both are done.
  const profileRun = (async () => {
    const mbid = artist.mbid ?? (rowDeezerIds[0] ? await bridgeArtist(rowDeezerIds[0], artist.name) : null)
    return mbid ? musicbrainz.getArtist(mbid) : null
  })()
  const profileOrNull = profileRun.catch((error: unknown) => {
    warn(`MusicBrainz profile of ${artist.name} failed`, error)
    return null
  })

  // 1. The quick Deezer pass. For an artist MusicBrainz knows, it uses the Deezer page
  // MusicBrainz links when the profile comes back in time, else the row's page, which
  // search may have linked by name alone: then the profile is checked afterwards.
  let quick: { deezerId: string; created: string[] } | null = null
  if (!placeholder && rowDeezerIds.length > 0) {
    const early = artist.mbid ? await Promise.race([profileOrNull, sleep(profileWaitMs).then(() => undefined)]) : undefined
    const linked = early ? deezerArtistIds(early.urls).filter((one) => rowDeezerIds.includes(one)) : []
    const deezerId = await mainDeezerArtist(linked.length > 0 ? linked : early && deezerArtistIds(early.urls).length > 0 ? deezerArtistIds(early.urls) : rowDeezerIds)
    if (deezerId) {
      let created: string[] = []
      await attempt('Deezer discography', async () => {
        created = await deezerDiscography(artistId, deezerId, { max: quickDeezerAlbums })
      })
      quick = { deezerId, created }
      // An artist without an MBID is known by this page; one with an MBID waits for the
      // profile to confirm the page before taking its popular tracks (and their credits).
      if (!artist.mbid) await attempt('top tracks', () => topTracks(artistId, { mbid: null, deezerId }))
      await changed([queryKeys.artist(artistId)])
      ready()
    }
  }

  let profile = await profileOrNull
  // A bridge by name search that lands on an artist whose Deezer pages are others is a
  // namesake's MusicBrainz entry: the row stays the Deezer artist it is.
  if (profile && !artist.mbid && deezerArtistIds(profile.urls).length > 0 && !rowDeezerIds.some((one) => deezerArtistIds(profile!.urls).includes(one))) profile = null
  let target = artistId
  let complete = false
  if (profile) {
    const mbLinked = deezerArtistIds(profile.urls)
    // MusicBrainz lists the artist's own Deezer pages; a page the row had by name alone
    // that is not one of them is a namesake's ("Drake", the metal band), with its albums.
    if (artist.mbid && quick && mbLinked.length > 0 && !mbLinked.includes(quick.deezerId)) {
      const stray = quick
      await attempt('namesake Deezer page', () => detachDeezerArtist(artistId, stray.deezerId, stray.created))
      await changed([queryKeys.artist(artistId)])
    }
    target = await adoptMbidNow('artist', artistId, profile.mbid)
    const [row] = await db.select({ name: artists.name }).from(artists).where(eq(artists.id, target))
    const name = displayName(row?.name ?? profile.name, profile)
    await db.update(artists).set({
      name,
      sortName: name === profile.name ? profile.sortName : name,
      nameKey: matchKey(name),
      disambiguation: profile.disambiguation || null,
      kind: profile.type,
      country: profile.country,
      genres: genreNames(profile.genres),
      updatedAt: new Date(),
    }).where(eq(artists.id, target))
    for (const one of mbLinked) await linkExternalId('deezer', 'artist', one, target)
    const deezerId = await mainDeezerArtist(mbLinked.length > 0 ? mbLinked : await deezerIdsOf(target))

    // 2. Each a request or two, so the page fills in before the discography is done.
    const steps = [
      await attempt('artist image', () => artistImage(target, { mbid: profile.mbid, wikidataId: profile.wikidataId, deezerId, informed: true })),
      placeholder || await attempt('bio', () => artistBio(target, profile.wikidataId)),
      placeholder || await attempt('top tracks', () => topTracks(target, { mbid: profile.mbid, deezerId })),
    ]
    await changed(pageKeys(target, artistId))

    // 3. MusicBrainz's discography, a page of 100 groups at a time.
    let published = Date.now()
    const discography = placeholder || await attempt('discography', () => musicbrainz.browseReleaseGroups(profile.mbid, {
      officialOnly: true,
      onPage: async (groups) => {
        await upsertDiscography(groups)
        ready()
        if (Date.now() - published >= publishEveryMs) {
          published = Date.now()
          await changed(pageKeys(target, artistId))
        }
      },
    }))
    complete = discography && steps.every(Boolean)
    if (placeholder) await db.update(artists).set({ bio: null, bioSource: null, bioUrl: null }).where(eq(artists.id, target))
  } else if (quick || rowDeezerIds.length > 0) {
    // MusicBrainz could not name the artist (or failed): Deezer is all there is.
    const deezerId = quick?.deezerId ?? await mainDeezerArtist(rowDeezerIds)
    if (deezerId) {
      // The quick pass listed the newest albums; an artist only Deezer knows gets the rest too.
      await attempt('Deezer discography', () => deezerDiscography(target, deezerId, { max: deezerOnlyAlbums }))
      await attempt('artist image', () => artistImage(target, { mbid: null, wikidataId: null, deezerId, informed: false }))
      if (artist.mbid || !quick) await attempt('top tracks', () => topTracks(target, { mbid: null, deezerId }))
    }
  }
  // Stubs that search wrote while the discography was fetched, or under a second row of
  // this artist merged since, are folded into their releases now (reconcile.ts).
  await reconcileArtistAlbums(target)
  await db.update(artists).set({
    detailLevel: complete ? 2 : sql`greatest(${artists.detailLevel}, 1)`,
    fetchedAt: new Date(),
    updatedAt: new Date(),
  }).where(eq(artists.id, target))
  await changed(pageKeys(target, artistId))
  return target
}

function pageKeys(target: string, artistId: string) {
  return [queryKeys.artist(target), ...(target === artistId ? [] : [queryKeys.artist(artistId)])]
}

/**
 * Upserts an album row (`detail_level` at least 1) for each release group, adopting the
 * stubs search or Deezer made for it (`stubsByGroup`), with its credits and, while it has
 * none, the Cover Art Archive's front cover as a lazy remote image (a group without one
 * 404s once and is not offered again for a week). Rows are keyed by MBID, so running it
 * again changes nothing. Returns the ids of albums it created.
 */
export async function upsertDiscography(groups: readonly MbReleaseGroupSummary[]): Promise<string[]> {
  if (groups.length === 0) return []
  // Albums whose stubs were merged or took the MBID: pages, lists and playlists that show
  // them change, whichever caller (an artist page, the new-release job) wrote them.
  const adopted = new Set<string>()
  const rows = await db.transaction(async (tx) => {
    await lockUpserts(tx)
    const artistIds = await upsertArtists(tx, groups.flatMap((group) => group.artistCredit))
    const stubs = await stubsByGroup(tx, groups, artistIds)
    const written: { id: string; mbid: string; artworkAssetId: string | null; inserted: boolean }[] = []
    for (const group of groups) {
      for (const id of await adoptStubs(tx, group.mbid, stubs.get(group.mbid) ?? [])) adopted.add(id)
      const values = {
        mbid: group.mbid,
        title: group.title,
        artistCredit: group.artistName,
        primaryArtistId: group.artistCredit[0] ? artistIds.get(group.artistCredit[0].mbid)! : null,
        type: group.type,
        typeGuessed: false,
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
  await changed([...adopted].map((id) => queryKeys.album(id)))
  if ((await getServerSettings()).coverArtArchiveEnabled) {
    for (const row of rows) {
      if (row.artworkAssetId) continue
      const asset = await remoteImage(`https://coverartarchive.org/release-group/${row.mbid}/front-500`, { kind: 'cover' })
      // The archive said lately that the group has no cover (the art route then unassigns
      // it); offering it again would only answer 404 until it is worth asking again.
      if (asset.status === 'failed' && asset.checkedAt && Date.now() - asset.checkedAt.getTime() < coverRetryMs) continue
      await assignAlbumArtwork(row.id, asset.id, { onlyIfEmpty: true })
    }
  }
  return rows.filter((row) => row.inserted).map((row) => row.id)
}

/** Squirmy's long-form types, which Deezer all calls "album". */
const longForm = new Set(['album', 'compilation', 'live', 'soundtrack', 'other'])

/** Whether a stub's type fits a release group's: `group` is MusicBrainz's, `stub` a provider's. */
const compatibleTypes = (group: string, stub: string) => group === stub || group === 'other' || stub === 'other'
  // Deezer's "ep" is often MusicBrainz's "single", and the other way round.
  || ((group === 'ep' || group === 'single') && (stub === 'ep' || stub === 'single'))
  // Deezer types soundtracks, live albums and most compilations "album": Inception and
  // Pulse stayed beside their release groups, yearless, under Albums.
  || (stub === 'album' && longForm.has(group))

/**
 * Album rows search or Deezer created for the discography's release groups: no MBID, no
 * files, led by an artist the group credits (its first credit before any other), the same
 * release once edition suffixes and store labels are dropped (`releaseKey`: "Inception
 * (Music from the Motion Picture)" is "Inception") and a compatible type (any, for a
 * guessed one). A release two groups of the artist share
 * ("Weezer") names neither, so its stubs are left alone. Keyed by group MBID.
 */
async function stubsByGroup(tx: Transaction, groups: readonly MbReleaseGroupSummary[], artistIds: Map<string, string>): Promise<Map<string, string[]>> {
  const creditedOf = (group: MbReleaseGroupSummary) => group.artistCredit.flatMap((credit) => artistIds.get(credit.mbid) ?? [])
  const credited = [...new Set(groups.flatMap(creditedOf))]
  if (credited.length === 0) return new Map()
  const rows = await tx.execute<{ id: string; title: string; type: string; typeGuessed: boolean; artistId: string }>(sql`
    select a.id, a.title, a.type, a.type_guessed as "typeGuessed", a.primary_artist_id as "artistId" from albums a
    where a.mbid is null and a.merged_into_id is null and a.primary_artist_id = any(${uuidArray(credited)})
      and not exists (select 1 from media_files f where f.album_id = a.id)`)
  const result = new Map<string, string[]>()
  const groupKeys = groups.map((group) => ({ group, primary: creditedOf(group)[0] ?? null, credited: new Set(creditedOf(group)), key: releaseKey(group.title) }))
  for (const row of rows) {
    const key = releaseKey(row.title)
    if (!key) continue
    // A guessed type (a track's album reference) fits any group of the title.
    const same = groupKeys.filter((one) => one.key === key && (row.typeGuessed || compatibleTypes(one.group.type, row.type)))
    // The group the stub's artist leads; else one that credits it further on. Deezer lists an
    // artist's features among its albums without saying whose they are, so the artist page
    // made them its own ("Talk Ya Shit", Busta Rhymes's single), and they stayed beside the
    // release under Appears on.
    const led = same.filter((one) => one.primary === row.artistId)
    const fits = led.length > 0 ? led : same.filter((one) => one.credited.has(row.artistId))
    if (fits.length !== 1) continue
    const mbid = fits[0]!.group.mbid
    result.set(mbid, [...(result.get(mbid) ?? []), row.id])
  }
  return result
}

/**
 * Makes the stubs of a release group one row with its MBID before it is upserted: merged
 * into the row that has it, else the first takes it and the others merge into that one.
 * Merges leave redirects, so ids clients hold keep working.
 */
async function adoptStubs(tx: Transaction, mbid: string, stubIds: readonly string[]): Promise<string[]> {
  if (stubIds.length === 0) return []
  const [existing] = await tx.select({ id: albums.id }).from(albums).where(eq(albums.mbid, mbid))
  let into = existing ? await resolveMerged(tx, albums, existing.id) : null
  for (const id of stubIds) {
    if (into) await mergeAlbum(id, into, tx)
    else {
      await tx.update(albums).set({ mbid, updatedAt: new Date() }).where(eq(albums.id, id))
      into = id
    }
  }
  return [...stubIds, into!]
}

/**
 * The artist's picture: Deezer's of the artist's own page, else fanart.tv, else Wikidata,
 * as a lazy remote image. An image from the user's folders always stays. `informed` says
 * the sources come from the MusicBrainz profile (its own Deezer pages): then a picture
 * taken earlier from a page search linked by name, which may be a namesake's, is replaced.
 * Without it an image the artist has stays.
 */
async function artistImage(artistId: string, sources: { mbid: string | null; wikidataId: string | null; deezerId: string | null; informed: boolean }) {
  const [row] = await db.execute<{ imageAssetId: string | null; source: string | null }>(sql`
    select a.image_asset_id as "imageAssetId", s.source from artists a left join assets s on s.id = a.image_asset_id where a.id = ${artistId}`)
  if (!row) return
  const local = row.imageAssetId !== null && !/^https?:\/\//i.test(row.source ?? '')
  if (local || (row.imageAssetId && !sources.informed)) return
  const url = (sources.deezerId ? (await deezer.getArtist(Number(sources.deezerId)))?.imageUrl : null)
    ?? (sources.mbid ? (await fanart.getArtistImages(sources.mbid))?.thumbnails[0]?.replace(/^http:/, 'https:') : null)
    ?? (sources.wikidataId ? (await wikidata.getImage(sources.wikidataId))?.url : null)
  const picked = sources.informed ? new Date() : null
  if (!url || url === row.source) {
    if (row.imageAssetId) await db.update(artists).set({ imagePickedAt: picked }).where(eq(artists.id, artistId))
    return
  }
  const asset = await remoteImage(url, { kind: 'artist' })
  await db.update(artists).set({ imageAssetId: asset.id, imagePickedAt: picked, updatedAt: new Date() })
    .where(and(eq(artists.id, artistId), row.imageAssetId ? eq(artists.imageAssetId, row.imageAssetId) : isNull(artists.imageAssetId)))
}

/**
 * Chooses an artist's picture again from its MusicBrainz profile, for the release repair:
 * pictures chosen before pages were told apart from namesakes, or kept through a merge.
 * False when a source failed.
 */
export async function repickArtistImage(artistId: string): Promise<boolean> {
  const [artist] = await db.select({ mbid: artists.mbid }).from(artists).where(eq(artists.id, artistId))
  if (!artist?.mbid) return true
  const mbid = artist.mbid
  return attempt('artist image', async () => {
    const profile = await musicbrainz.getArtist(mbid)
    if (!profile) return
    const linked = deezerArtistIds(profile.urls)
    const deezerId = await mainDeezerArtist(linked.length > 0 ? linked : await deezerIdsOf(artistId))
    await artistImage(artistId, { mbid, wikidataId: profile.wikidataId, deezerId, informed: true })
  })
}

/** The English Wikipedia summary, with a link to the article. */
async function artistBio(artistId: string, wikidataId: string | null) {
  const summary = wikidataId ? await wikidata.getWikipediaSummary(wikidataId) : null
  if (!summary) return
  await db.update(artists).set({ bio: summary.text, bioSource: 'wikipedia', bioUrl: summary.sourceUrl, updatedAt: new Date() }).where(eq(artists.id, artistId))
}

/**
 * Runs the Deezer top tracks again for an artist, which gives each its album (and so its
 * artwork) and stores the artist's list. For popular tracks stored before they kept their
 * album or their order. False when Deezer failed.
 */
export async function refreshTopTracks(artistId: string): Promise<boolean> {
  const ids = await deezerIdsOf(artistId)
  if (ids.length === 0) return true
  return attempt('top tracks', async () => {
    const deezerId = await mainDeezerArtist(ids)
    await topTracks(artistId, { mbid: null, deezerId })
  })
}

/** Replaces the artist's stored list of popular tracks (`artist_top_tracks`), in rank order. */
async function storeTopTracks(artistId: string, source: 'deezer' | 'listenbrainz', recordingIds: readonly string[]) {
  const ids = [...new Set(recordingIds)]
  await db.transaction(async (tx) => {
    await tx.delete(artistTopTracks).where(eq(artistTopTracks.artistId, artistId))
    if (ids.length > 0) await tx.insert(artistTopTracks).values(ids.map((recordingId, position) => ({ artistId, position, recordingId, source })))
  })
}

/**
 * The artist's popular tracks, stored in rank order (`artist_top_tracks`) with a 0..1
 * popularity on each: Deezer's top tracks, which are what a store lists as the artist's
 * hits and come with their albums, else ListenBrainz's most listened recordings (with a
 * server token and an MBID), creating stub rows for tracks the catalog lacks.
 */
async function topTracks(artistId: string, sources: { mbid: string | null; deezerId: string | null }) {
  if (sources.deezerId) {
    const top = await deezer.getArtistTopTracks(Number(sources.deezerId), { limit: topTrackCount })
    if (top.length > 0) {
      const max = Math.max(0, ...top.map((track) => track.rank ?? 0))
      const ids: string[] = []
      for (const [index, track] of top.entries()) {
        const id = await deezerTopTrackRow(artistId, sources.deezerId, track)
        const popularity = track.rank ? share(track.rank, max) : share(top.length - index, top.length)
        await db.update(recordings).set({ popularity }).where(eq(recordings.id, id))
        ids.push(id)
      }
      await storeTopTracks(artistId, 'deezer', ids)
      return
    }
  }
  const listened = sources.mbid ? await listenbrainz.topRecordingsForArtist(sources.mbid, { limit: topTrackCount }) : []
  if (listened.length === 0) return
  const max = Math.max(...listened.map((one) => one.listenCount))
  const ids: string[] = []
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
    ids.push(id)
  }
  await storeTopTracks(artistId, 'listenbrainz', ids)
}
