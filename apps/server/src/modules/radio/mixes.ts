/**
 * Mixes made for a user (Home's Made for you), in the manner of a "Daily Mix":
 *
 * 1. Profile the user's listening: the artists of their completed plays over the last
 *    `LISTENING_DAYS`, weighted toward recent plays, with the genres of each artist and of
 *    the albums the user played of it.
 * 2. Measure how well each pair of those artists goes together (`affinity`): their genres
 *    (and the words of them, so "Folk" meets "Indie Folk"), the similar-artist data radio uses
 *    (similar.ts), how often the user plays both in one sitting, and how alike they sound once
 *    that analysis exists (the `artistSoundAffinity` seam).
 * 3. Cluster: the most played artist not yet in a mix starts one, and takes the artists that
 *    go with the mix's artists on average, most played first. A cluster becomes a mix when its
 *    artists hold enough of the listening.
 * 4. Fill each mix with the user's favourite songs by its artists and songs like them, picked
 *    by radio's ranking (`suggest`) seeded with those favourites, interleaved so the mix opens
 *    on a favourite and keeps returning to them. No song is in two mixes.
 *
 * Mixes are made once a day (catalog's `catalog.home-picks` job) and stored, so a mix stays
 * the same all day; random choices are seeded by the user, the day and the slot. A mix is a
 * slot: "Mix 1" keeps its id while its songs change.
 */
import type { MixDetail, MixSummary, TrackSummary } from '@squirmy/contracts'
import { and, asc, eq, gt, sql } from 'drizzle-orm'
import { db } from '../../database/client.js'
import { mixes } from '../../database/schema.js'
import { notFound } from '../../lib/errors.js'
import { newId } from '../../lib/ids.js'
import { completedPlay, placeholderArtist, playArtist, uuidArray } from '../catalog/sql.js'
import { servable, trackSummaries } from '../catalog/summaries.js'
import { isRequester, suggest } from './ranking.js'
import { similarArtists } from './similar.js'
import { artistSoundAffinity, pairKey } from './sonic.js'

/** Most mixes a user has. */
export const MIX_LIMIT = 6
/** Songs in a mix. */
export const MIX_LENGTH = 50
/** How far back a user's listening shapes their mixes. */
const LISTENING_DAYS = 90
/** Half-life-ish of a play's weight: a play this many days old counts a third as much. */
const DECAY_DAYS = 30
/** The user's most played artists that mixes are made from. */
const TOP_ARTISTS = 40
/** Artists, most played first, whose similar artists are looked up. */
const SIMILAR_LOOKUPS = 12
/** Longest wait for the similar-artist lookups, all together. */
const SIMILAR_TIMEOUT_MS = 8000
/** Most artists in one mix's cluster. */
const CLUSTER_SIZE = 8
/** Least average affinity that brings an artist into a mix. */
export const LINKED = 0.35
/** Least completed plays of a mix's artists over `LISTENING_DAYS` for it to be made. */
const MIN_MIX_PLAYS = 6
/** Least completed plays for one artist alone to make a mix. */
const MIN_SOLO_PLAYS = 12
/** Fewest songs a mix may have; a cluster with fewer is not a mix. */
const MIN_MIX_TRACKS = 10
/** Favourites in a mix, and how many of them seed its suggestions. */
const FAVOURITES = 15
const SEEDS = 10
/** How far back favourites are found. */
const FAVOURITE_DAYS = 180

/**
 * `sessions`: the hours the user played the artist in, a sitting each. `genres`: genre → weight,
 * and each word of a genre under `~word` at three quarters of its weight.
 */
type ListenedArtist = { id: string; name: string; plays: number; sessions: number; score: number; genres: Map<string, number> }

type Signals = {
  similar: Map<string, number>
  together: Map<string, number>
  sound: Map<string, number> | null
}

export type MadeMix = { label: string; artistIds: string[]; tracks: { id: string; albumId: string | null; durationMs: number }[] }

const genreKey = (genre: string) => genre.trim().toLowerCase()

/** Adds a genre and its words ("indie folk": "indie", "folk") to an artist's genres. */
function addGenre(genres: Map<string, number>, genre: string, weight: number) {
  const key = genreKey(genre)
  genres.set(key, Math.max(genres.get(key) ?? 0, weight))
  for (const word of key.split(/[\s/-]+/).filter((one) => one.length > 2 && one !== 'and')) {
    genres.set(`~${word}`, Math.max(genres.get(`~${word}`) ?? 0, weight * 0.75))
  }
}

/** A seeded generator (mulberry32) from a text, so one user's mixes of one day repeat exactly. */
export function seededRandom(text: string): () => number {
  let state = 0
  for (let index = 0; index < text.length; index++) state = (Math.imul(state, 31) + text.charCodeAt(index)) >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** A genre as a mix's name shows it: "indie folk" is "Indie Folk", "r&b" is "R&B". */
export function genreLabel(genre: string): string {
  return genreKey(genre).split(/(\s+|-|\/)/).map((word) => {
    if (word === 'and' || word === 'of' || /^\s+$|^[-/]$/.test(word)) return word
    if (/^[a-z]&[a-z]$/.test(word) || word === 'edm' || word === 'uk' || word === 'us') return word.toUpperCase()
    return word.charAt(0).toUpperCase() + word.slice(1)
  }).join('')
}

/** "A", "A and B", "A, B and C", "A, B, C and more". */
export function artistLine(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? ''
  if (names.length === 2) return `${names[0]} and ${names[1]}`
  if (names.length === 3) return `${names[0]}, ${names[1]} and ${names[2]}`
  return `${names.slice(0, 3).join(', ')} and more`
}

/** The user's most played artists of the last `LISTENING_DAYS`, best first, with their genres. */
async function listenedArtists(userId: string): Promise<ListenedArtist[]> {
  const listened = sql`
    select p.album_id, p.started_at, ${playArtist('r')} as artist_id
    from plays p join recordings r on r.id = p.recording_id
    where p.user_id = ${userId} and ${completedPlay('p')}
      and p.started_at > now() - make_interval(days => ${LISTENING_DAYS})`
  const rows = await db.execute<{ id: string; name: string; plays: number; sessions: number; score: number; genres: string[] }>(sql`
    select a.id, a.name, count(*)::int as plays, count(distinct date_trunc('hour', l.started_at))::int as sessions,
      sum(exp(-extract(epoch from now() - l.started_at) / ${DECAY_DAYS * 86_400}))::float8 as score,
      coalesce(a.genres, '{}') as genres
    from (${listened}) l join artists a on a.id = l.artist_id
    where a.merged_into_id is null and not ${placeholderArtist('a')}
    group by a.id order by score desc, a.id limit ${TOP_ARTISTS}`)
  if (rows.length === 0) return []
  const albumGenres = await db.execute<{ artistId: string; genre: string; plays: number }>(sql`
    select l.artist_id as "artistId", g.genre, count(*)::int as plays
    from (${listened}) l join albums al on al.id = l.album_id cross join unnest(al.genres) g(genre)
    where l.artist_id = any(${uuidArray(rows.map((row) => row.id))})
    group by 1, 2`)
  const artists = rows.map((row) => {
    const genres = new Map<string, number>()
    for (const genre of row.genres) addGenre(genres, genre, 1)
    return { id: row.id, name: row.name, plays: row.plays, sessions: row.sessions, score: row.score, genres }
  })
  const byId = new Map(artists.map((artist) => [artist.id, artist]))
  for (const row of albumGenres) {
    const artist = byId.get(row.artistId)
    if (!artist) continue
    // An album genre counts by the share of the artist's plays it holds, beside the artist's own genres.
    addGenre(artist.genres, row.genre, Math.min(1, row.plays / artist.plays))
  }
  return artists
}

/** In how many sittings (hours) the user played both artists of each pair, as a cosine of their sittings (0..1). */
async function playedTogether(userId: string, artists: ListenedArtist[]): Promise<Map<string, number>> {
  const ids = artists.map((artist) => artist.id)
  const rows = await db.execute<{ a: string; b: string; sessions: number }>(sql`
    with sittings as (
      select distinct ${playArtist('r')} as artist_id, date_trunc('hour', p.started_at) as hour
      from plays p join recordings r on r.id = p.recording_id
      where p.user_id = ${userId} and ${completedPlay('p')}
        and p.started_at > now() - make_interval(days => ${LISTENING_DAYS})
    )
    select x.artist_id as a, y.artist_id as b, count(*)::int as sessions
    from sittings x join sittings y on y.hour = x.hour and x.artist_id < y.artist_id
    where x.artist_id = any(${uuidArray(ids)}) and y.artist_id = any(${uuidArray(ids)})
    group by 1, 2`)
  const sessions = new Map(artists.map((artist) => [artist.id, artist.sessions]))
  return new Map(rows.map((row) => [pairKey(row.a, row.b), row.sessions / Math.sqrt((sessions.get(row.a) ?? 1) * (sessions.get(row.b) ?? 1))]))
}

/** Radio's similar artists of the most played artists, as pair → similarity. A source that fails or takes too long adds nothing. */
async function similarPairs(artists: ListenedArtist[]): Promise<Map<string, number>> {
  const listed = new Set(artists.map((artist) => artist.id))
  const pairs = new Map<string, number>()
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never[]>((resolve) => { timer = setTimeout(() => resolve([]), SIMILAR_TIMEOUT_MS) })
  const lookups = Promise.all(artists.slice(0, SIMILAR_LOOKUPS).map(async (artist) =>
    (await similarArtists(artist.id).catch(() => [])).map((one) => ({ from: artist.id, ...one }))))
  const answers = await Promise.race([lookups, timeout]).finally(() => clearTimeout(timer))
  for (const one of answers.flat()) {
    if (!listed.has(one.artistId)) continue
    const key = pairKey(one.from, one.artistId)
    pairs.set(key, Math.max(pairs.get(key) ?? 0, one.score))
  }
  return pairs
}

function cosine(a: Map<string, number>, b: Map<string, number>): number {
  let dot = 0
  for (const [genre, weight] of a) dot += weight * (b.get(genre) ?? 0)
  if (dot === 0) return 0
  const norm = (vector: Map<string, number>) => Math.sqrt([...vector.values()].reduce((sum, weight) => sum + weight * weight, 0))
  return dot / (norm(a) * norm(b))
}

/**
 * How well two artists go together in one mix, 0..1: a noisy-or of the signals, so any one
 * strong signal is enough. Shared genres, similar-artist data, or being played in the same
 * sittings again and again can each link two artists; a little of several adds up.
 */
export function affinity(a: ListenedArtist, b: ListenedArtist, signals: Signals): number {
  const key = pairKey(a.id, b.id)
  const genre = cosine(a.genres, b.genres)
  const similar = signals.similar.get(key) ?? 0
  const together = signals.together.get(key) ?? 0
  const sound = signals.sound?.get(key) ?? 0
  return 1 - (1 - 0.85 * genre) * (1 - 0.9 * similar) * (1 - 0.5 * together) * (1 - 0.85 * sound)
}

/** Groups the artists into at most `MIX_LIMIT` clusters, most played first. */
export function cluster(artists: ListenedArtist[], signals: Signals): ListenedArtist[][] {
  const remaining = [...artists]
  const clusters: ListenedArtist[][] = []
  while (remaining.length && clusters.length < MIX_LIMIT) {
    const members = [remaining.shift()!]
    for (let index = 0; index < remaining.length && members.length < CLUSTER_SIZE;) {
      const candidate = remaining[index]!
      const link = members.reduce((sum, member) => sum + affinity(member, candidate, signals), 0) / members.length
      if (link >= LINKED) {
        members.push(candidate)
        remaining.splice(index, 1)
      } else index++
    }
    const plays = members.reduce((sum, member) => sum + member.plays, 0)
    if (members.length > 1 ? plays >= MIN_MIX_PLAYS : plays >= MIN_SOLO_PLAYS) clusters.push(members)
  }
  return clusters
}

/** Least genre similarity of a suggestion to its mix, when the suggestion's genres are known. */
const ON_TOPIC = 0.15

/**
 * Leaves out suggestions whose genres are known and have nothing to do with the mix's.
 * Radio's ranking pads a batch with unrelated songs when the related ones run out (a radio
 * would rather keep playing); a mix is better a few songs shorter than off its theme. Songs
 * by the mix's artists, and songs whose genres nothing says, stay: those come from the
 * similar-artist and radio pools, related by other means.
 */
async function onTopic(tracks: TrackSummary[], members: ListenedArtist[]): Promise<TrackSummary[]> {
  const theme = new Map<string, number>()
  for (const member of members) for (const [genre, weight] of member.genres) theme.set(genre, (theme.get(genre) ?? 0) + weight)
  const artists = new Set(members.map((member) => member.id))
  const albumIds = [...new Set(tracks.flatMap((track) => (track.album ? [track.album.id] : [])))]
  const rows = albumIds.length ? await db.execute<{ id: string; genres: string[] }>(sql`
    select al.id, coalesce(al.genres, '{}') || coalesce(ar.genres, '{}') as genres
    from albums al left join artists ar on ar.id = al.primary_artist_id where al.id = any(${uuidArray(albumIds)})`) : []
  const genresOf = new Map(rows.map((row) => [row.id, row.genres]))
  return tracks.filter((track) => {
    if (track.artists.some((artist) => artists.has(artist.id))) return true
    const genres = track.album ? genresOf.get(track.album.id) ?? [] : []
    if (genres.length === 0) return true
    const vector = new Map<string, number>()
    for (const genre of genres) addGenre(vector, genre, 1)
    return cosine(vector, theme) >= ON_TOPIC
  })
}

/** A mix's name after its slot: its two leading genres, else its first two artists. */
function labelOf(members: ListenedArtist[], taken: Set<string>): string {
  const weights = new Map<string, number>()
  for (const member of members) {
    const total = [...member.genres].reduce((sum, [genre, weight]) => sum + (genre.startsWith('~') ? 0 : weight), 0)
    for (const [genre, weight] of member.genres) {
      if (!genre.startsWith('~')) weights.set(genre, (weights.get(genre) ?? 0) + (member.score * weight) / total)
    }
  }
  const ranked = [...weights].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  const top = ranked[0]?.[1] ?? 0
  const genres = ranked.filter(([, weight]) => weight >= top / 4).slice(0, 2).map(([genre]) => genreLabel(genre))
  const byGenre = genres.join(', ')
  if (byGenre && !taken.has(byGenre)) return byGenre
  return members.slice(0, 2).map((member) => member.name).join(', ')
}

/** The user's most played songs by the artists over `FAVOURITE_DAYS`, most played first. */
async function favourites(userId: string, artistIds: string[]): Promise<{ id: string; albumId: string | null }[]> {
  return db.execute<{ id: string; albumId: string | null }>(sql`
    select p.recording_id as id, (array_agg(p.album_id order by p.started_at desc))[1] as "albumId"
    from plays p join recordings r on r.id = p.recording_id
    where p.user_id = ${userId} and ${completedPlay('p')}
      and p.started_at > now() - make_interval(days => ${FAVOURITE_DAYS})
      and (r.primary_artist_id = any(${uuidArray(artistIds)}) or exists (
        select 1 from recording_artists ra where ra.recording_id = r.id and ra.artist_id = any(${uuidArray(artistIds)})))
    group by p.recording_id order by count(*) desc, max(p.started_at) desc limit ${FAVOURITES * 3}`)
}

/** Whether the user can start the track now, by the queue's rule. */
const playable = (track: TrackSummary, requester: boolean) =>
  track.availability === 'server' || (track.availability === 'on_demand' && requester)

/**
 * Favourites and suggestions in one order: a favourite first, then two suggestions to each
 * favourite while both last, never one artist twice in a row when another order avoids it.
 */
export function interleave(loved: TrackSummary[], fresh: TrackSummary[], length: number): TrackSummary[] {
  const queues = [[...loved], [...fresh]]
  const result: TrackSummary[] = []
  const artistOf = (track: TrackSummary) => track.artists[0]?.id ?? track.artistCredit
  for (let turn = 0; result.length < length && (queues[0]!.length || queues[1]!.length); turn++) {
    const preferred = turn % 3 === 0 ? 0 : 1
    const queue = queues[preferred]!.length ? queues[preferred]! : queues[1 - preferred]!
    const last = result.at(-1)
    const at = last ? queue.findIndex((track) => artistOf(track) !== artistOf(last)) : 0
    result.push(queue.splice(Math.max(at, 0), 1)[0]!)
  }
  return result
}

/**
 * The user's mixes for today, best first, without storing them. `day` seeds the random
 * choices (an ISO date), so a second run on the same day picks the same songs.
 */
export async function makeMixes(userId: string, day: string): Promise<MadeMix[]> {
  const artists = await listenedArtists(userId)
  if (artists.length === 0) return []
  const [similar, together, sound, requester] = await Promise.all([
    similarPairs(artists),
    playedTogether(userId, artists),
    artistSoundAffinity(artists.map((artist) => artist.id)).catch(() => null),
    isRequester(userId),
  ])
  const clusters = cluster(artists, { similar, together, sound })
  const used = new Set<string>()
  const labels = new Set<string>()
  const made: MadeMix[] = []
  for (const [index, members] of clusters.entries()) {
    const artistIds = members.map((member) => member.id)
    const loved = (await trackSummaries(userId, await favourites(userId, artistIds)))
      .filter((track) => playable(track, requester) && !used.has(track.id)).slice(0, FAVOURITES)
    if (loved.length === 0) continue
    const seeds = loved.slice(0, SEEDS).map((track) => track.id).toReversed()
    const suggested = await suggest(
      { userId, seeds, exclude: [...used, ...loved.map((track) => track.id)], limit: MIX_LENGTH - loved.length },
      { random: seededRandom(`${userId}:${day}:${index}`) },
    )
    const suggestions = (await trackSummaries(userId, suggested.map((seed) => ({ id: seed.trackId, albumId: seed.albumId }))))
      .filter((track) => playable(track, requester) && !used.has(track.id))
    const fresh = await onTopic(suggestions, members)
    const tracks = interleave(loved, fresh, MIX_LENGTH)
    if (tracks.length < MIN_MIX_TRACKS) continue
    for (const track of tracks) used.add(track.id)
    const label = labelOf(members, labels)
    labels.add(label)
    made.push({
      label,
      artistIds,
      tracks: tracks.map((track) => ({ id: track.id, albumId: track.album?.id ?? null, durationMs: track.durationMs })),
    })
  }
  return made
}

/** Stores the user's mixes in their slots, keeping each slot's id, and drops slots past them. */
export async function saveMixes(userId: string, made: readonly MadeMix[]) {
  await db.transaction(async (tx) => {
    for (const [index, mix] of made.entries()) {
      await tx.insert(mixes).values({ id: newId(), userId, position: index + 1, label: mix.label, artistIds: mix.artistIds, tracks: mix.tracks })
        .onConflictDoUpdate({
          target: [mixes.userId, mixes.position],
          set: { label: mix.label, artistIds: mix.artistIds, tracks: mix.tracks, generatedAt: sql`now()` },
        })
    }
    await tx.delete(mixes).where(and(eq(mixes.userId, userId), gt(mixes.position, made.length)))
  })
}

type MixRow = typeof mixes.$inferSelect

/** Summaries of the stored mixes, in the order of the rows. */
async function summaries(rows: MixRow[]): Promise<MixSummary[]> {
  if (rows.length === 0) return []
  const albumIds = [...new Set(rows.flatMap((row) => row.tracks.flatMap((track) => (track.albumId ? [track.albumId] : []))))]
  const artistIds = [...new Set(rows.flatMap((row) => row.artistIds))]
  const [covers, names] = await Promise.all([
    db.execute<{ albumId: string; id: string; color: string | null; thumbhash: string | null }>(sql`
      select al.id as "albumId", art.id, art.color, art.thumbhash
      from albums al join assets art on art.id = al.artwork_asset_id and ${servable('art')}
      where al.id = any(${uuidArray(albumIds)})`),
    db.execute<{ id: string; name: string }>(sql`
      select requested.id, coalesce(merged.name, a.name) as name from unnest(${uuidArray(artistIds)}) requested(id)
      join artists a on a.id = requested.id left join artists merged on merged.id = a.merged_into_id`),
  ])
  const coverOf = new Map(covers.map(({ albumId, ...artwork }) => [albumId, artwork]))
  const nameOf = new Map(names.map((row) => [row.id, row.name]))
  return rows.map((row) => {
    const artworks = [...new Set(row.tracks.flatMap((track) => (track.albumId ? [track.albumId] : [])))]
      .flatMap((albumId) => coverOf.get(albumId) ?? []).slice(0, 4)
    return {
      id: row.id,
      name: `Mix ${row.position} · ${row.label}`,
      description: artistLine(row.artistIds.flatMap((id) => nameOf.get(id) ?? [])),
      artworks,
      trackCount: row.tracks.length,
      durationMs: row.tracks.reduce((sum, track) => sum + track.durationMs, 0),
      generatedAt: row.generatedAt.toISOString(),
    }
  })
}

/** The user's mixes, Mix 1 first, with the artists each was made from (most played first). */
export async function listMixes(userId: string): Promise<{ mix: MixSummary; artistIds: string[] }[]> {
  const rows = await db.select().from(mixes).where(eq(mixes.userId, userId)).orderBy(asc(mixes.position))
  const listed = await summaries(rows)
  return listed.map((mix, index) => ({ mix, artistIds: rows[index]!.artistIds }))
}

/** Some of the user's mixes, in the order asked; ids that are not theirs are left out. */
export async function mixSummaries(userId: string, ids: readonly string[]): Promise<MixSummary[]> {
  if (ids.length === 0) return []
  const rows = await db.select().from(mixes).where(and(eq(mixes.userId, userId), sql`${mixes.id} = any(${uuidArray([...ids])})`))
  const listed = await summaries(rows)
  const byId = new Map(listed.map((mix) => [mix.id, mix]))
  return ids.flatMap((id) => byId.get(id) ?? [])
}

/** One of the user's mixes with the songs they can play now, in play order. */
export async function mixDetail(userId: string, id: string): Promise<MixDetail> {
  const [row] = await db.select().from(mixes).where(and(eq(mixes.id, id), eq(mixes.userId, userId)))
  if (!row) throw notFound('No such mix')
  const [[summary], requester, tracks] = await Promise.all([summaries([row]), isRequester(userId), trackSummaries(userId, row.tracks)])
  const playing = tracks.filter((track) => playable(track, requester))
  return {
    ...summary!,
    trackCount: playing.length,
    durationMs: playing.reduce((sum, track) => sum + track.durationMs, 0),
    tracks: playing,
  }
}
