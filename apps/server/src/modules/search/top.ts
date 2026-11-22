/**
 * Ranking a route's answer: the signals rank.ts weighs, read for the results in a fixed
 * number of queries, and `SearchResults.top`, the result a client can lead with.
 */
import type { SearchResults, SearchTopResult } from '@squirmy/contracts'
import { inArray, sql } from 'drizzle-orm'
import { db } from '../../database/client.js'
import { recordings } from '../../database/schema.js'
import { uuidArray } from '../catalog/sql.js'
import { rank, topOf, type RankInput, type RankSignals, type Ranked } from './rank.js'

export type Found = Pick<SearchResults, 'artists' | 'albums' | 'tracks'>

/** Plays considered, newest first. The same bound as the library search's tie-break. */
const recentPlays = 1000

export function rankInputs(found: Found): RankInput[] {
  return [
    ...found.artists.map((artist, position): RankInput => ({
      type: 'artist', id: artist.id, name: artist.name, artistCredit: null, artistNames: [], artistIds: [], albumId: null, position,
    })),
    ...found.albums.map((album, position): RankInput => ({
      type: 'album', id: album.id, name: album.title, artistCredit: album.artistCredit, albumType: album.type,
      artistNames: album.artists.map((artist) => artist.name), artistIds: album.artists.map((artist) => artist.id), albumId: null, position,
    })),
    ...found.tracks.map((track, position): RankInput => ({
      type: 'track', id: track.id, name: track.title, artistCredit: track.artistCredit,
      artistNames: track.artists.map((artist) => artist.name), artistIds: track.artists.map((artist) => artist.id), albumId: track.album?.id ?? null, position,
    })),
  ]
}

type SignalOptions = {
  /** The viewer, whose plays and likes count. */
  userId?: string | null
  /** 0..1 popularity the provider gave, by id; stored song popularity fills in the rest. */
  popularity?: ReadonlyMap<string, number>
  /** Ids known to be in the viewer's library beyond what the summaries say (the library search's answer). */
  owned?: Iterable<string>
}

/** What rank.ts weighs besides the names: popularity, the viewer's library, plays and likes. */
export async function searchSignals(found: Found, options: SignalOptions = {}): Promise<RankSignals> {
  const trackIds = found.tracks.map((track) => track.id)
  const allIds = [...found.artists, ...found.albums, ...found.tracks].map((item) => item.id)
  const userId = options.userId ?? null
  const [stored, played, likedRows] = await Promise.all([
    trackIds.length > 0
      ? db.select({ id: recordings.id, popularity: recordings.popularity }).from(recordings).where(inArray(recordings.id, trackIds))
      : [],
    userId && allIds.length > 0
      ? db.execute<{ id: string; plays: number }>(sql`
          with recent as (select recording_id, album_id from plays where user_id = ${userId} order by started_at desc limit ${recentPlays})
          select recording_id as id, count(*)::int as plays from recent where recording_id = any(${uuidArray(trackIds)}) group by 1
          union all
          select album_id, count(*)::int from recent where album_id = any(${uuidArray(found.albums.map((album) => album.id))}) group by 1
          union all
          select ra.artist_id, count(*)::int from recent r join recording_artists ra on ra.recording_id = r.recording_id
          where ra.artist_id = any(${uuidArray(found.artists.map((artist) => artist.id))}) group by 1`)
      : [],
    userId && allIds.length > 0
      ? db.execute<{ id: string }>(sql`select entity_id as id from likes where user_id = ${userId} and entity_id = any(${uuidArray(allIds)})`)
      : [],
  ])

  const popularity = new Map(options.popularity ?? [])
  for (const row of stored) {
    if (row.popularity !== null) popularity.set(row.id, Math.max(row.popularity, popularity.get(row.id) ?? 0))
  }
  const owned = new Set(options.owned ?? [])
  for (const item of [...found.artists, ...found.tracks]) if (item.inLibrary) owned.add(item.id)
  const plays = new Map<string, number>()
  for (const row of played) plays.set(row.id, (plays.get(row.id) ?? 0) + row.plays)
  const liked = new Set(likedRows.map((row) => row.id))
  for (const track of found.tracks) if (track.liked) liked.add(track.id)
  return { popularity, owned, plays, liked }
}

/** Every result of `found`, best first (`SearchResults.ranked`). */
export async function rankFound(query: string, found: Found, options: SignalOptions = {}): Promise<Ranked[]> {
  return rank(query, rankInputs(found), await searchSignals(found, options))
}

/**
 * Picks the result to lead with (see rank.ts): a far more prominent prefix match beats an
 * exact name, and a result found only through its artist never leads. Null when no name
 * matches at least as a prefix, a later word or one typo away.
 */
export async function topResult(query: string, found: Found, options: SignalOptions = {}): Promise<SearchTopResult | null> {
  return topOf(await rankFound(query, found, options))
}
