import type { HomeItem, HomeQuery, HomeResponse, HomeSection, MixSummary, PlaylistSummary, RadioSummary, TrackSummary } from '@squirmy/contracts'
import { sql } from 'drizzle-orm'
import { db } from '../../database/client.js'
import { getServerSettings } from '../../lib/settings.js'
import { newReleaseAlbumIds } from '../enrichment/releases.js'
import { isRequester, listMixes, mixSummaries } from '../radio/index.js'
import { listPlaylists, playlistSummaries } from '../userdata/playlists.js'
import { refreshWants, wantedAlbumIds } from '../userdata/wants.js'
import { explicitAllowed, withoutExplicit } from './explicit.js'
import { homePicksOf, queueHomePicksWhenDue } from './home-picks.js'
import { resolveMerged } from './redirects.js'
import { listLibraryAlbums } from './library.js'
import { completedPlay, listened } from './sql.js'
import { albumSummaries, artistSummaries, trackSummaries } from './summaries.js'

const RAIL = 20
// Recently played and Jump back in look at this many latest plays, which bounds the work for heavy listeners.
const RECENT_PLAYS = 500
/** Cards in Jump back in, and how many places are read to fill them past ones that are gone. */
const JUMP_BACK_IN = 12
const JUMP_BACK_IN_READ = 30
/** Days of listening behind Most played. */
const MOST_PLAYED_DAYS = 90
/** Fewest artists for Your top artists to show. */
const MIN_TOP_ARTISTS = 3
/** Plays at this time of day, over the 90 days the picks' profile covers, before Home is ordered by them. */
const MIN_DAYPART_PLAYS = 10
/** Plays of an artist before what time of day it is played at counts. */
const MIN_ARTIST_PLAYS = 3

/**
 * The Home screen. `GET /home` answers the personal layout to apps that ask for it
 * (`layout: 'personal'`) and the earlier one, `classicHome`, to app builds from before it.
 */
export async function home(userId: string, query: HomeQuery = {}): Promise<HomeResponse> {
  return query.layout === 'personal' ? personalHome(userId, query.tz) : classicHome(userId)
}

/**
 * The Home of app builds before the personal one, in this order (product decision 30: for
 * someone who streams, what they played is the front page). Section ids are stable; a
 * section without content is left out.
 *
 * - `recently-played`: albums of the user's latest plays.
 * - `most-played`: the user's tracks with the most completed plays over the last 90 days,
 *   without explicit ones for a user who has explicit content off.
 * - `playlists`: the user's own playlists, recently updated first.
 * - `recently-added`: the server's albums (its collection), the newest collection file
 *   first, whatever is in the user's library: Home is where the server's music is found,
 *   and its See all is `/collection/albums`. Music fetched for playing never enters it. It
 *   was the user's library albums while the collection was in every library.
 * - `new-releases`: recent albums by the user's own artists that their library lacks,
 *   newest first (`newReleaseAlbumIds`).
 * - `wantlist`: albums on the user's wantlist, newest first. Only while the wantlist is on.
 */
async function classicHome(userId: string): Promise<HomeResponse> {
  const { wantlistEnabled } = await getServerSettings()
  if (wantlistEnabled) await refreshWants(userId)
  const [recentlyAdded, recentlyPlayed, mostPlayed, playlists, wanted, newReleases] = await Promise.all([
    listLibraryAlbums(null, { sort: 'recent', limit: RAIL }),
    db.execute<{ id: string }>(sql`
      select recent.album_id as id from (
        select album_id, started_at from plays p where user_id = ${userId} and ${listened('p')} order by started_at desc limit ${RECENT_PLAYS}
      ) recent
      where recent.album_id is not null
      group by recent.album_id order by max(recent.started_at) desc limit ${RAIL}`).then((rows) => albumSummaries(rows.map((row) => row.id))),
    mostPlayedTracks(userId),
    listPlaylists(userId, { limit: RAIL }, { ownOnly: true }),
    wantlistEnabled ? wantedAlbumIds(userId, RAIL).then(albumSummaries) : [],
    newReleaseAlbumIds(userId, RAIL).then(albumSummaries),
  ])
  const sections: HomeSection[] = [
    { kind: 'albums', id: 'recently-played', title: 'Recently played', albums: recentlyPlayed },
    { kind: 'tracks', id: 'most-played', title: 'Most played', tracks: mostPlayed },
    { kind: 'playlists', id: 'playlists', title: 'Your playlists', playlists: playlists.items },
    { kind: 'albums', id: 'recently-added', title: 'New on this server', albums: recentlyAdded.items },
    { kind: 'albums', id: 'new-releases', title: 'New releases', albums: newReleases },
    { kind: 'albums', id: 'wantlist', title: 'Wantlist', albums: wanted },
  ]
  return { sections: sections.filter(hasItems) }
}

/**
 * The personal Home, made of the user's own listening and the server's music; nothing on it
 * is chosen by anyone else. Section ids are stable; a section without content is left out.
 *
 * - `jump-back-in` (items): the albums, playlists, artists, Liked Songs, mixes and radios the
 *   user last played from, newest first, each once (`jumpBackIn`).
 * - `made-for-you` (items): the user's mixes (radio/mixes.ts), made each morning.
 * - `because-you-listened` (artists): "Because you listened to <artist>", artists like one the
 *   user played most this month, with music on the server (radio/because.ts).
 * - `top-artists` (artists): the artists of the user's most completed plays over 30 days,
 *   when there are at least three.
 * - `rediscover` (tracks): songs the user played a lot six to 24 months ago and not lately
 *   (without explicit ones for a user who has explicit content off, as Most played).
 * - `most-played`: as in the classic Home.
 * - `playlists`, `new-releases`, `recently-added`, `wantlist`: as in the classic Home.
 *
 * Mixes, Because you listened to, Your top artists, Rediscover and the time-of-day profile
 * are made ahead of time, once a day (home-picks.ts); reading Home queues that run when it is
 * due. With the device's time zone, the rails from Made for you to Most played are ordered by
 * how well they fit this part of the day, by when the user plays their artists (`daypartFit`),
 * and the mixes among themselves too (`byTimeOfDay`); nothing says so.
 */
async function personalHome(userId: string, tz: string | undefined): Promise<HomeResponse> {
  const { wantlistEnabled } = await getServerSettings()
  if (wantlistEnabled) await refreshWants(userId)
  const [picks, mixes, requester, allowsExplicit] = await Promise.all([homePicksOf(userId), listMixes(userId), isRequester(userId), explicitAllowed(userId)])
  const playable = (track: TrackSummary) =>
    (track.availability === 'server' || (track.availability === 'on_demand' && requester)) && (allowsExplicit || track.explicit !== true)
  const [jump, because, becauseSeed, topArtists, rediscover, mostPlayed, playlists, recentlyAdded, newReleases, wanted, daypart] = await Promise.all([
    jumpBackIn(userId),
    picks ? artistSummaries(picks.becauseArtistIds, userId) : [],
    picks?.becauseArtistId ? artistSummaries([picks.becauseArtistId], userId).then((found) => found[0]) : undefined,
    picks ? artistSummaries(picks.topArtistIds, userId) : [],
    picks ? trackSummaries(userId, picks.rediscover).then((tracks) => tracks.filter(playable).slice(0, RAIL)) : [],
    mostPlayedTracks(userId),
    listPlaylists(userId, { limit: RAIL }, { ownOnly: true }),
    listLibraryAlbums(null, { sort: 'recent', limit: RAIL }),
    newReleaseAlbumIds(userId, RAIL).then(albumSummaries),
    wantlistEnabled ? wantedAlbumIds(userId, RAIL).then(albumSummaries) : [],
    tz && picks ? daypartFit(picks.hourly, tz) : null,
    queueHomePicksWhenDue(userId, picks, mixes.length),
  ])

  const fit = (cards: string[][]) => (daypart ? fitOf(daypart, cards) : 0)
  const eachArtist = (ids: string[]) => ids.map((id) => [id])
  const orderedMixes = byTimeOfDay(mixes, (one) => fit(eachArtist(one.artistIds))).map((one) => one.mix)
  const becauseArtists = becauseSeed ? because : []
  const personal: { section: HomeSection; cards: string[][] }[] = [
    { section: { kind: 'items', id: 'made-for-you', title: 'Made for you', items: orderedMixes.map(mixItem) }, cards: mixes.map((one) => one.artistIds) },
    {
      section: { kind: 'artists', id: 'because-you-listened', title: becauseSeed ? `Because you listened to ${becauseSeed.name}` : '', artists: becauseArtists },
      cards: becauseSeed ? [[becauseSeed.id], ...eachArtist(becauseArtists.map((artist) => artist.id))] : [],
    },
    {
      section: { kind: 'artists', id: 'top-artists', title: 'Your top artists', artists: topArtists.length >= MIN_TOP_ARTISTS ? topArtists : [] },
      cards: eachArtist(topArtists.map((artist) => artist.id)),
    },
    { section: { kind: 'tracks', id: 'rediscover', title: 'Rediscover', tracks: rediscover }, cards: rediscover.map(trackArtists) },
    { section: { kind: 'tracks', id: 'most-played', title: 'Most played', tracks: mostPlayed }, cards: mostPlayed.map(trackArtists) },
  ]
  const sections: HomeSection[] = [
    { kind: 'items', id: 'jump-back-in', title: 'Jump back in', items: jump },
    ...byTimeOfDay(personal.filter((one) => hasItems(one.section)), (one) => fit(one.cards)).map((one) => one.section),
    { kind: 'playlists', id: 'playlists', title: 'Your playlists', playlists: playlists.items },
    { kind: 'albums', id: 'new-releases', title: 'New releases', albums: newReleases },
    { kind: 'albums', id: 'recently-added', title: 'New on this server', albums: recentlyAdded.items },
    { kind: 'albums', id: 'wantlist', title: 'Wantlist', albums: wanted },
  ]
  return { sections: sections.filter(hasItems) }
}

const trackArtists = (track: TrackSummary) => track.artists.map((artist) => artist.id)
const mixItem = (mix: MixSummary): HomeItem => ({ kind: 'mix', mix })

export const mostPlayedQuery = (userId: string) => sql`
  select recording_id as id, (array_agg(album_id order by started_at desc))[1] as "albumId"
  from plays p where user_id = ${userId} and ${completedPlay('p')} and started_at > now() - make_interval(days => ${MOST_PLAYED_DAYS})
  group by recording_id order by count(*) desc, max(started_at) desc limit ${RAIL}`

async function mostPlayedTracks(userId: string): Promise<TrackSummary[]> {
  const [rows, allowed] = await Promise.all([db.execute<{ id: string; albumId: string | null }>(mostPlayedQuery(userId)), explicitAllowed(userId)])
  return withoutExplicit(await trackSummaries(userId, rows), allowed)
}

type Place = { kind: 'album' | 'artist' | 'playlist' | 'liked' | 'mix' | 'radio'; id: string }

export const jumpBackInQuery = (userId: string) => sql`
  with recent as (
    select p.context_type, p.context_id, p.album_id, p.started_at from plays p
    where p.user_id = ${userId} and ${listened('p')} order by p.started_at desc limit ${RECENT_PLAYS}
  ), placed as (
    select case when context_type in ('playlist', 'artist', 'liked', 'mix', 'radio') then context_type else 'album' end as kind,
      case when context_type in ('playlist', 'artist', 'mix', 'radio') then context_id
        when context_type = 'liked' then 'liked'
        else album_id::text end as id,
      started_at as at
    from recent
    union all
    select cp.entity_type, case when cp.entity_type = 'liked' then 'liked' else cp.entity_id::text end, cp.played_at
    from (select * from collection_plays where user_id = ${userId} order by played_at desc limit ${JUMP_BACK_IN_READ}) cp
  )
  select kind, id from placed where id is not null
  group by kind, id order by max(at) desc, kind, id limit ${JUMP_BACK_IN_READ}`

const radioId = /^(track|artist):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i

/**
 * Where the user last played from, newest first, each place once: the context of each of
 * their latest plays (a playlist, an artist, Liked Songs, a mix or a radio), else the album
 * the song was played from (a song from an album page, Search, Home or the history), and the
 * collections they started or added to the library (`collection_plays`), whose plays may be
 * older than the latest 500. Places that are gone, or a playlist they may no longer see,
 * are left out.
 */
export async function jumpBackIn(userId: string): Promise<HomeItem[]> {
  const places = await db.execute<Place>(jumpBackInQuery(userId))
  const idsOf = (kind: Place['kind']) => places.flatMap((place) => (place.kind === kind ? [place.id] : []))
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  const valid = (ids: string[]) => ids.filter((id) => uuid.test(id))
  const radios = places.flatMap((place) => {
    const match = place.kind === 'radio' ? radioId.exec(place.id) : null
    return match ? [{ seed: match[1]!.toLowerCase() as 'track' | 'artist', id: match[2]!.toLowerCase() }] : []
  })
  const [albumIds, artistIds] = await Promise.all([resolveMerged('albums', valid(idsOf('album'))), resolveMerged('artists', valid(idsOf('artist')))])
  const [albums, artists, playlists, mixes, radioTracks, radioArtists] = await Promise.all([
    albumSummaries([...new Set(albumIds.values())]),
    artistSummaries([...new Set(artistIds.values())], userId),
    playlistSummaries(valid(idsOf('playlist')), userId),
    mixSummaries(userId, valid(idsOf('mix'))),
    trackSummaries(userId, radios.filter((radio) => radio.seed === 'track').map((radio) => ({ id: radio.id }))),
    artistSummaries(radios.filter((radio) => radio.seed === 'artist').map((radio) => radio.id), userId),
  ])
  // A place played before a merge is listed as the row it became.
  const albumById = new Map(albums.map((album) => [album.id, album]))
  const artistById = new Map(artists.map((artist) => [artist.id, artist]))
  const albumOf = (id: string) => albumById.get(albumIds.get(id) ?? '')
  const artistOf = (id: string) => artistById.get(artistIds.get(id) ?? '')
  const playlistOf = new Map(playlists.filter((playlist) => visible(playlist, userId)).map((playlist) => [playlist.id, playlist]))
  const mixOf = new Map(mixes.map((mix) => [mix.id, mix]))
  const radioOf = new Map<string, RadioSummary>()
  for (const track of radioTracks) {
    radioOf.set(`track:${track.id}`, { seed: 'track', id: track.id, title: track.title, subtitle: track.artistCredit, albumId: track.album?.id ?? null, artwork: track.album?.artwork ?? null })
  }
  for (const artist of radioArtists) radioOf.set(`artist:${artist.id}`, { seed: 'artist', id: artist.id, title: artist.name, subtitle: null, albumId: null, artwork: artist.image })

  const items: HomeItem[] = []
  const seen = new Set<string>()
  const add = (key: string, item: HomeItem | undefined) => {
    if (!item || seen.has(key)) return
    seen.add(key)
    items.push(item)
  }
  for (const place of places) {
    if (items.length >= JUMP_BACK_IN) break
    switch (place.kind) {
      case 'album': {
        const album = albumOf(place.id)
        add(`album:${album?.id}`, album && { kind: 'album', album })
        break
      }
      case 'artist': {
        const artist = artistOf(place.id)
        add(`artist:${artist?.id}`, artist && { kind: 'artist', artist })
        break
      }
      case 'playlist': {
        const playlist = playlistOf.get(place.id)
        add(`playlist:${place.id}`, playlist && { kind: 'playlist', playlist })
        break
      }
      case 'liked':
        add('liked', { kind: 'liked' })
        break
      case 'mix': {
        const mix = mixOf.get(place.id)
        add(`mix:${place.id}`, mix && { kind: 'mix', mix })
        break
      }
      case 'radio': {
        const match = radioId.exec(place.id)
        const radio = match ? radioOf.get(`${match[1]!.toLowerCase()}:${match[2]!.toLowerCase()}`) : undefined
        add(`radio:${radio?.seed}:${radio?.id}`, radio && { kind: 'radio', radio })
        break
      }
    }
  }
  return items
}

const visible = (playlist: PlaylistSummary, userId: string) => playlist.ownerId === userId || playlist.isPublic

/** The hour (0..23) it is now in the time zone; null for a zone the runtime does not know. */
function localHour(tz: string, now: Date): number | null {
  try {
    return Number(new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hourCycle: 'h23' }).format(now))
  } catch {
    return null
  }
}

const dayparts = [[5, 6, 7, 8, 9, 10, 11], [12, 13, 14, 15, 16], [17, 18, 19, 20, 21], [22, 23, 0, 1, 2, 3, 4]]

/** The local hours of the part of the day it is now in the time zone: morning, afternoon, evening or night. */
export function daypartHours(tz: string, now = new Date()): number[] | null {
  const hour = localHour(tz, now)
  return hour === null ? null : dayparts.find((part) => part.includes(hour)) ?? null
}

/**
 * How much of each artist's listening falls in this part of the day where the user is (0..1),
 * from the hourly profile the day's picks hold (plays per UTC hour): 1 for an artist the user
 * plays only in the morning, when it is morning. Artists with too few plays to tell are left
 * out, and so is everything when the user plays too little at this part of the day.
 */
export function daypartFit(hourly: Record<string, number[]>, tz: string, now = new Date()): Map<string, number> | null {
  const hour = localHour(tz, now)
  const local = daypartHours(tz, now)
  if (hour === null || !local) return null
  // Whole hours: a zone half an hour off is placed by the hour it shows.
  const offset = hour - now.getUTCHours()
  const utc = local.map((one) => (((one - offset) % 24) + 24) % 24)
  let atThisTime = 0
  const fit = new Map<string, number>()
  for (const [id, hours] of Object.entries(hourly)) {
    const all = hours.reduce((sum, plays) => sum + plays, 0)
    const here = utc.reduce((sum, one) => sum + (hours[one] ?? 0), 0)
    atThisTime += here
    if (all >= MIN_ARTIST_PLAYS) fit.set(id, here / all)
  }
  return atThisTime >= MIN_DAYPART_PLAYS ? fit : null
}

/**
 * How well a rail fits this part of the day: the mean, over its cards, of how much of their
 * artists' listening falls in it (`daypartFit`). Cards by artists it cannot tell about are left
 * out of the mean, so they neither lift nor sink a rail.
 */
export function fitOf(fit: Map<string, number>, cards: readonly (readonly string[])[]): number {
  const values = cards.flatMap((artistIds) => {
    const known = artistIds.flatMap((id) => fit.get(id) ?? [])
    return known.length ? [known.reduce((sum, one) => sum + one, 0) / known.length] : []
  })
  return values.length ? values.reduce((sum, one) => sum + one, 0) / values.length : 0
}

/**
 * Items that fit this part of the day best first, in quarters, so only a clear difference
 * moves anything; within a quarter they keep their order.
 */
export function byTimeOfDay<T>(items: readonly T[], share: (item: T) => number): T[] {
  return items.map((item, index) => ({ item, index, rank: Math.round(share(item) * 4) }))
    .sort((a, b) => b.rank - a.rank || a.index - b.index)
    .map((one) => one.item)
}

function hasItems(section: HomeSection): boolean {
  switch (section.kind) {
    case 'albums': return section.albums.length > 0
    case 'artists': return section.artists.length > 0
    case 'tracks': return section.tracks.length > 0
    case 'playlists': return section.playlists.length > 0
    case 'items': return section.items.length > 0
  }
}
