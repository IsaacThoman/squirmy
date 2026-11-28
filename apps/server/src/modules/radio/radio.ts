import type { QueueSeed, RadioResponse } from '@squirmy/contracts'
import { sql } from 'drizzle-orm'
import { db } from '../../database/client.js'
import { AppError, notFound } from '../../lib/errors.js'
import { albumCoveredWithoutTracks, onDemandRecordings } from '../acquisition/coverage.js'
import { canonicalRelease, recordingOwned } from '../catalog/availability.js'
import { resolveOne } from '../catalog/redirects.js'
import { trackSummaries } from '../catalog/summaries.js'
import { ensureAlbumDetail } from '../enrichment/detail.js'
import { isRequester, suggest, type SuggestOptions } from './ranking.js'

/** Tracks in a new radio, the seed included. */
export const RADIO_LENGTH = 50

/** The artist's tracks considered for the first one; enough to reach past a few uncovered ones. */
const ARTIST_START_CANDIDATES = 200
/** Albums whose track lists an artist radio fetches when nothing of the artist is known to play. */
const TRACK_LIST_FETCHES = 2

const nothingPlayable = () => new AppError(409, 'nothing_playable', 'Nothing by this artist can be played')

async function radioFrom(userId: string, seedId: string, context: RadioResponse['context'], options: SuggestOptions): Promise<RadioResponse> {
  const [[track], requester] = await Promise.all([trackSummaries(userId, [{ id: seedId }]), isRequester(userId)])
  // The rule the queue applies: a file plays for everyone, `on_demand` only for a user who
  // may have tracks fetched. Anything else would start a radio whose first entry is dropped.
  if (!track || track.availability === 'none' || (track.availability === 'on_demand' && !requester)) {
    throw new AppError(409, 'not_playable', 'This track cannot be played')
  }
  const seed: QueueSeed = {
    trackId: track.id,
    albumId: track.album?.id ?? null,
    durationMs: track.durationMs,
    state: track.availability === 'server' ? 'ready' : 'preparing',
  }
  const rest = await suggest({ userId, seeds: [track.id], exclude: [], limit: RADIO_LENGTH - 1 }, options)
  return { context: { ...context, title: context.title ?? track.title }, tracks: [seed, ...rest] }
}

/** A radio starting with the track and continuing with suggestions seeded by it. */
export async function trackRadio(userId: string, trackId: string, options: SuggestOptions = {}): Promise<RadioResponse> {
  const id = await resolveOne('recordings', trackId)
  if (!id) throw notFound('No such track')
  return radioFrom(userId, id, { type: 'radio', id: `track:${id}`, title: null }, options)
}

/**
 * The artist's tracks the user can play, best start first: most played by the user, then
 * liked, then owned (so a radio starts at once when it can), then popular; ties broken by
 * `salt`. For a requester that includes what a provider can fetch (`on_demand`), so an
 * artist with nothing on the server still starts from its top tracks and discography.
 */
async function playableArtistTracks(userId: string, artistId: string, requester: boolean, salt: number): Promise<string[]> {
  const rows = await db.execute<{ id: string; owned: boolean }>(sql`
    select r.id, ${recordingOwned('r.id')} as owned from recordings r
    -- The artist's tracks as the artist page counts them: credited, or led without credit rows.
    where r.id in (
        select ra.recording_id from recording_artists ra where ra.artist_id = ${artistId}
        union select led.id from recordings led where led.primary_artist_id = ${artistId}
      )
      and r.merged_into_id is null
      ${requester ? sql`` : sql`and ${recordingOwned('r.id')}`}
    order by (select count(*) from plays p where p.user_id = ${userId} and p.recording_id = r.id and not p.skipped) desc,
      exists (select 1 from likes l where l.user_id = ${userId} and l.entity_type = 'recording' and l.entity_id = r.id) desc,
      ${recordingOwned('r.id')} desc,
      r.popularity desc nulls last,
      uuid_hash_extended(r.id, ${salt})
    limit ${ARTIST_START_CANDIDATES}`)
  const unowned = rows.filter((row) => !row.owned).map((row) => row.id)
  const onDemand = requester && unowned.length > 0 ? await onDemandRecordings(unowned) : new Set<string>()
  return rows.filter((row) => row.owned || onDemand.has(row.id)).map((row) => row.id)
}

/**
 * The artist's albums with no track list yet, when a provider would play them anyway (an
 * album search or the discography found, `on_demand` by the album rule). Studio albums
 * first, newest first.
 */
async function tracklessCoveredAlbums(artistId: string, limit: number): Promise<string[]> {
  const rows = await db.execute<{ id: string }>(sql`
    select a.id from albums a
    where a.merged_into_id is null
      and a.id in (
        select aa.album_id from album_artists aa where aa.artist_id = ${artistId}
        union select led.id from albums led where led.primary_artist_id = ${artistId}
      )
      and not exists (select 1 from release_tracks rt where rt.release_id = ${canonicalRelease('a')})
      and not exists (select 1 from media_files f where f.album_id = a.id and f.missing_since is null)
    order by a.type = 'album' desc, coalesce(a.release_date, a.year::text) desc nulls last, a.id
    limit ${limit}`)
  // Asked only when there is such an album, so the common case costs one query.
  return rows.length > 0 && (await albumCoveredWithoutTracks()) ? rows.map((row) => row.id) : []
}

/**
 * Whether `artistRadio` would start for the user, without fetching anything: something of
 * the artist plays for them, or (for a requester) an album of it would once its track
 * list is known. The artist page uses it to offer the radio only when it works.
 */
export async function canStartArtistRadio(userId: string, artistId: string): Promise<boolean> {
  const requester = await isRequester(userId)
  if ((await playableArtistTracks(userId, artistId, requester, 0)).length > 0) return true
  return requester && (await tracklessCoveredAlbums(artistId, 1)).length > 0
}

/**
 * A radio starting with the artist's top playable track (most played by the user, then
 * liked, owned, popular; ties broken at random) and continuing with suggestions. For a
 * requester it draws on what can be fetched too, like the queue; when nothing of the
 * artist has a track list yet, it fetches a couple of album track lists first.
 */
export async function artistRadio(userId: string, artistId: string, options: SuggestOptions = {}): Promise<RadioResponse> {
  const id = await resolveOne('artists', artistId)
  if (!id) throw notFound('No such artist')
  const [[artist], requester] = await Promise.all([
    db.execute<{ name: string }>(sql`select name from artists where id = ${id}`),
    isRequester(userId),
  ])
  const salt = Math.floor((options.random ?? Math.random)() * 2 ** 32)
  let top = (await playableArtistTracks(userId, id, requester, salt))[0]
  if (!top && requester) {
    // An artist known only from search has albums without track lists, and so no tracks.
    // Each fetch waits at most the page budget, so the radio still answers in seconds.
    const albums = await tracklessCoveredAlbums(id, TRACK_LIST_FETCHES)
    if (albums.length > 0) {
      await Promise.all(albums.map((albumId) => ensureAlbumDetail(albumId)))
      top = (await playableArtistTracks(userId, id, requester, salt))[0]
    }
  }
  if (!top || !artist) throw nothingPlayable()
  return radioFrom(userId, top, { type: 'radio', id: `artist:${id}`, title: artist.name }, options)
}
