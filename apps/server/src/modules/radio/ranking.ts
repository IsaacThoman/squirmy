/**
 * Track suggestions for autoplay and radios.
 *
 * 1. Profile the seeds: their artists, genres (album and artist) and years, the artists
 *    similar to them (similar.ts), and Deezer's radio of the most recent seed artists
 *    (enrichment's `artistRadioTracks`: their tracks and popular tracks of artists like
 *    them, written as catalog rows). The radio's artists count as similar artists too.
 * 2. Gather a few hundred candidates in one query, from bounded pools: tracks by the seed
 *    artists, by similar artists, Deezer's radio, on albums sharing a genre, on albums from
 *    the same years, played near the seeds in the user's history, liked tracks, tracks by
 *    liked artists, and a few random albums so the pool is never empty.
 * 3. Score each candidate (see `weights`), plus noise so runs differ. A candidate is
 *    related to the seeds when it is by a seed or similar artist, in Deezer's radio, shares
 *    their genres, or the user played it near a seed on several days. Likes and popularity
 *    only order candidates; they never make one related.
 * 4. Pick greedily under variety rules over a sliding window of `WINDOW` tracks that
 *    includes the seeds: at most two tracks per artist, one per album and three by seed
 *    artists, never the same artist twice in a row. Related candidates go first, under the
 *    strict rules and then relaxed ones. Unrelated ones (the random albums, a liked track
 *    of another genre) only fill a batch up to one window (`FILL_UP_TO`); past that a
 *    batch ends early rather than play them. The rules drop last.
 *
 * For a user who may have tracks fetched (an admin, or `canAcquire`), tracks an acquisition
 * provider can supply (`on_demand`) from the artist, similar-artist, radio and liked pools
 * are ranked together with the owned ones, so a server that holds few files still has a
 * radio. Owning a track is not a reason to suggest it: what is on the server is mostly
 * whatever was played lately. It only breaks a near tie for the first pick
 * (`INSTANT_MARGIN`), so playback after the seeds can start at once; the rest are fetched
 * ahead while the first ones play. Everyone else gets owned tracks only.
 *
 * An artist's tracks are the ones it is credited on, plus the ones it leads
 * (`primary_artist_id`): rows from older imports and catalog stubs can lack credit rows.
 */
import { canFetch } from '@squirmy/client-core'
import type { QueueSeed } from '@squirmy/contracts'
import { eq, sql, type SQL } from 'drizzle-orm'
import { db } from '../../database/client.js'
import { users } from '../../database/schema.js'
import { onDemandRecordings } from '../acquisition/coverage.js'
import { uuidArray } from '../catalog/sql.js'
import { artistRadioTracks } from '../enrichment/detail.js'
import { similarArtists } from './similar.js'

export type SuggestRequest = {
  userId: string
  /** Recordings the suggestions should resemble, most recent last. Never suggested themselves. */
  seeds: readonly string[]
  exclude: readonly string[]
  limit: number
}

export type SuggestOptions = {
  /** Uniform in [0, 1). Inject a seeded generator for repeatable suggestions. */
  random?: () => number
  /** Longest wait for the similar-artist services and Deezer's radio before ranking without them. */
  similarTimeoutMs?: number
}

/**
 * The ranking formula: a candidate's score is the sum of these weights times its
 * features, each in 0..1.
 *
 * - `sameArtist`: credited to a seed artist.
 * - `similarArtist`: the best similarity of its artists to a seed artist.
 * - `radio`: in Deezer's radio of a seed artist, 1 at the top falling to 0.5 at the end.
 * - `genre`: cosine similarity of its genres to the seeds' genres (recent seeds weigh more).
 * - `era`: 1 for the same year as a seed, falling to 0 ten years away.
 * - `coListened`: on how many days the user played it within half an hour of playing a
 *   seed: 0 for one day, rising to 1 at `CO_LISTENED_FULL` days. One day is one listening
 *   session (or several people testing one account), not a habit.
 * - `liked`, `likedArtist`, `likedAlbum`: the user liked the track, its artist, its album.
 * - `popularity`: the recording's popularity, when a source provided one.
 * - `recentlyPlayed`: the user played it in the last `RECENT_HOURS` hours.
 * - `noise`: uniform random, so two runs differ and equal candidates take turns.
 */
export const weights = {
  sameArtist: 2,
  similarArtist: 3,
  radio: 2.5,
  genre: 2,
  era: 0.75,
  coListened: 4,
  liked: 1.5,
  likedArtist: 1,
  likedAlbum: 0.5,
  popularity: 0.5,
  recentlyPlayed: -4,
  noise: 1,
}

/** Variety rules apply to any run of this many tracks. */
export const WINDOW = 10
const RECENT_HOURS = 3
/** Days of playing a track near a seed that earn the full `coListened` weight. */
const CO_LISTENED_FULL = 4
/** Seed artists whose similar artists are looked up, most recent first. */
const SIMILAR_LOOKUPS = 3
/** Seed artists whose Deezer radio is read, most recent first. */
const RADIO_LOOKUPS = 2
/** How similar an artist in Deezer's radio of a seed artist counts, when similar.ts does not rank it higher. */
const RADIO_ARTIST_SIMILARITY = 0.5
const SIMILAR_TIMEOUT_MS = 2500
/** The least the similar-artist lookup is waited for after Deezer's radio took its time. */
const MIN_SIMILAR_WAIT_MS = 500
/** Least genre similarity that makes a candidate related: one specific genre in common. */
export const GENRE_RELATED = 0.15
/**
 * How far below the best candidate an owned one may score and still take the first pick,
 * so playback after the seeds starts without a fetch. The noise's range: within it, the
 * order is a coin toss anyway.
 */
export const INSTANT_MARGIN = weights.noise

type Seed = { id: string; artistIds: string[]; primaryArtistId: string | null; albumId: string | null; year: number | null; genres: string[] }

type Candidate = Seed & {
  owned: boolean
  related: boolean
  durationMs: number
  liked: boolean
  likedArtist: boolean
  likedAlbum: boolean
  popularity: number
  recentlyPlayed: boolean
  coListened: number
  score: number
}

type Profile = {
  seeds: Seed[]
  artists: Set<string>
  /** Genre key → weight. */
  genres: Map<string, number>
  genreNorm: number
  years: number[]
  similar: Map<string, number>
  /** Recording → place in Deezer's radio of a seed artist (1 first, 0.5 last). */
  radio: Map<string, number>
}

const genreKey = (genre: string) => genre.trim().toLowerCase()

/** The album a recording is shown with: an owned file's album, else one it appears on. */
function albumOf(recording: string): SQL {
  return sql.raw(`coalesce(
    (select mf.album_id from media_files mf where mf.recording_id = ${recording} and mf.missing_since is null and mf.album_id is not null order by mf.added_at, mf.id limit 1),
    (select rel.album_id from release_tracks rt join releases rel on rel.id = rt.release_id where rt.recording_id = ${recording} order by rel.album_id limit 1))`)
}

/** Puts the lead artist among the credited ones, for rows that have no credit rows for it. */
function withLead<T extends { artistIds: string[]; primaryArtistId: string | null }>(row: T): T {
  const lead = row.primaryArtistId
  return lead && !row.artistIds.includes(lead) ? { ...row, artistIds: [...row.artistIds, lead] } : row
}

/**
 * Recordings by an artist that `artistIs` accepts: credited, or led without being
 * credited. `artistIs` gets the artist id column to test.
 */
function byArtist(artistIs: (column: SQL) => SQL): SQL {
  return sql`(select ra.recording_id as id from recording_artists ra where ${artistIs(sql`ra.artist_id`)}
    union select led.id from recordings led where ${artistIs(sql`led.primary_artist_id`)} and led.merged_into_id is null)`
}

/** Whether tracks may be fetched for the user, by the rule acquisition applies to a request. */
export async function isRequester(userId: string): Promise<boolean> {
  const [user] = await db.select({ role: users.role, canAcquire: users.canAcquire, disabledAt: users.disabledAt }).from(users).where(eq(users.id, userId))
  return Boolean(user && !user.disabledAt && canFetch(user))
}

/** Artists, album, year and genres of each recording, in the order given; missing ids are left out. */
async function describe(ids: readonly string[]): Promise<Seed[]> {
  if (ids.length === 0) return []
  const rows = await db.execute<Seed>(sql`
    select r.id, r.primary_artist_id as "primaryArtistId", al.id as "albumId", al.year,
      array(select ra.artist_id::text from recording_artists ra where ra.recording_id = r.id order by ra.position) as "artistIds",
      coalesce(al.genres, '{}') || coalesce(ar.genres, '{}') as genres
    from unnest(${uuidArray(ids)}) with ordinality s(id, n)
    join recordings r on r.id = s.id
    left join albums al on al.id = ${albumOf('r.id')}
    left join artists ar on ar.id = r.primary_artist_id
    order by s.n`)
  return rows.map(withLead)
}

/** Waits for `promise` at most `ms`, settling with `fallback` instead of throwing. */
function within<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<T>((resolve) => { timer = setTimeout(() => resolve(fallback), ms) })
  return Promise.race([promise.catch(() => fallback), timeout]).finally(() => clearTimeout(timer))
}

/** The seeds' lead artists, most recent first. */
const recentArtists = (seeds: Seed[], count: number) =>
  [...new Set(seeds.toReversed().flatMap((seed) => (seed.primaryArtistId ? [seed.primaryArtistId] : [])))].slice(0, count)

async function similarTo(seeds: Seed[], timeoutMs: number): Promise<Map<string, number>> {
  const lists = await within(Promise.all(recentArtists(seeds, SIMILAR_LOOKUPS).map((id) => similarArtists(id))), timeoutMs, [])
  const similar = new Map<string, number>()
  for (const list of lists) for (const one of list) similar.set(one.artistId, Math.max(similar.get(one.artistId) ?? 0, one.score))
  return similar
}

/** Deezer's radio of the most recent seed artists: recording → place (1 first, 0.5 last). */
async function radioOf(seeds: Seed[], timeoutMs: number): Promise<Map<string, number>> {
  // The seam answers within the wait with what it has; `within` only guards against a hang.
  const lists = await within(Promise.all(recentArtists(seeds, RADIO_LOOKUPS).map((id) => artistRadioTracks(id, { waitMs: timeoutMs }))), timeoutMs + 250, [])
  const radio = new Map<string, number>()
  for (const list of lists) {
    list.forEach((id, index) => radio.set(id, Math.max(radio.get(id) ?? 0, 1 - (0.5 * index) / list.length)))
  }
  return radio
}

/** The artists of the given recordings, credited or leading. */
async function artistsOf(ids: readonly string[]): Promise<string[]> {
  if (ids.length === 0) return []
  const rows = await db.execute<{ id: string }>(sql`
    select ra.artist_id as id from recording_artists ra where ra.recording_id = any(${uuidArray(ids)})
    union select r.primary_artist_id from recordings r where r.id = any(${uuidArray(ids)}) and r.primary_artist_id is not null`)
  return rows.map((row) => row.id)
}

function profileOf(seeds: Seed[], similar: Map<string, number>, radio: Map<string, number>, radioArtists: readonly string[]): Profile {
  for (const id of radioArtists) similar.set(id, Math.max(similar.get(id) ?? 0, RADIO_ARTIST_SIMILARITY))
  const genres = new Map<string, number>()
  seeds.forEach((seed, index) => {
    const weight = 0.5 + (0.5 * (index + 1)) / seeds.length
    for (const genre of new Set(seed.genres.map(genreKey))) genres.set(genre, (genres.get(genre) ?? 0) + weight)
  })
  const artists = new Set(seeds.flatMap((seed) => seed.artistIds))
  for (const id of artists) similar.delete(id)
  return {
    seeds,
    artists,
    genres,
    genreNorm: Math.sqrt([...genres.values()].reduce((sum, weight) => sum + weight * weight, 0)),
    years: seeds.flatMap((seed) => (seed.year ? [seed.year] : [])),
    similar,
    radio,
  }
}

/**
 * Candidate recording ids with on how many days each was played near a seed. `owned`
 * picks owned tracks; otherwise unowned tracks from the artist, similar, radio and liked
 * pools.
 */
async function gather(userId: string, profile: Profile, owned: boolean, salt: number): Promise<Map<string, number>> {
  // A salted hash orders rows randomly but repeatably for one salt.
  const shuffle = (column: string) => sql.raw(`uuid_hash_extended(${column}, ${salt})`)
  // A scalar subquery with a limit is probed per row through the index; an `exists` here
  // tends to become a hash join over every file.
  const ownership = (column: string) => sql.raw(`${owned ? '' : 'not '}coalesce((
    select true from media_files f where f.recording_id = ${column} and f.missing_since is null limit 1), false)`)
  const seedIds = uuidArray(profile.seeds.map((seed) => seed.id))
  const genres = sql`${`{${[...new Set(profile.seeds.flatMap((seed) => seed.genres))].map((genre) => JSON.stringify(genre)).join(',')}}`}::text[]`
  const [fromYear, toYear] = profile.years.length ? [Math.min(...profile.years) - 3, Math.max(...profile.years) + 3] : [0, -1]

  const seedArtists = uuidArray([...profile.artists])
  const pools: SQL[] = [
    sql`select t.id, 0 from ${byArtist((column) => sql`${column} = any(${seedArtists})`)} t
      where ${ownership('t.id')}
      order by ${shuffle('t.id')} limit 80`,
    sql`select pick.id, 0 from unnest(${uuidArray([...profile.similar.keys()])}) s(id) cross join lateral (
        select t.id from ${byArtist((column) => sql`${column} = s.id`)} t where ${ownership('t.id')}
        order by ${shuffle('t.id')} limit 10) pick`,
    sql`select r.id, 0 from unnest(${uuidArray([...profile.radio.keys()])}) r(id) where ${ownership('r.id')}`,
    sql`select l.entity_id, 0 from likes l
      where l.user_id = ${userId} and l.entity_type = 'recording' and ${ownership('l.entity_id')}
      order by ${shuffle('l.entity_id')} limit 60`,
    sql`select t.id, 0 from ${byArtist((column) => sql`${column} in (
        select entity_id from likes where user_id = ${userId} and entity_type = 'artist' order by ${shuffle('entity_id')} limit 20)`)} t
      where ${ownership('t.id')}
      order by ${shuffle('t.id')} limit 60`,
  ]
  if (owned) {
    pools.push(
      // One pass over the albums: some sharing a genre, some from the seeds' years, a few at
      // random; a few tracks of each, as a window takes one track per album anyway.
      sql`select file.recording_id, 0 from (
          select id from (
            select id, kind, row_number() over (partition by kind order by ${shuffle('id')}) as n from (
              select a.id, case when a.genres && ${genres} or ar.genres && ${genres} then 0 when a.year between ${fromYear} and ${toYear} then 1 else 2 end as kind
              from albums a left join artists ar on ar.id = a.primary_artist_id
              where a.merged_into_id is null
            ) typed
          ) ranked
          where n <= (array[40, 20, 15])[kind + 1]
          limit 75
        ) pick
        cross join lateral (
          select mf.recording_id from media_files mf where mf.album_id = pick.id and mf.missing_since is null and mf.recording_id is not null
          order by ${shuffle('mf.recording_id')} limit 4
        ) file`,
      // Tracks the user played within half an hour of playing a seed, by on how many days.
      sql`select p.recording_id, count(distinct (s.started_at at time zone 'UTC')::date)::int as days from (
          select started_at from plays where user_id = ${userId} and recording_id = any(${seedIds}) order by started_at desc limit 30
        ) s join plays p on p.user_id = ${userId} and p.started_at between s.started_at - interval '30 minutes' and s.started_at + interval '30 minutes'
        group by p.recording_id order by days desc, p.recording_id limit 150`,
    )
  }
  const rows = await db.execute<{ id: string; near: number }>(sql`
    select id, max(near)::int as near from (${sql.join(pools.map((pool) => sql`(${pool})`), sql` union all `)}) pool(id, near)
    group by id`)
  return new Map(rows.map((row) => [row.id, row.near]))
}

/** Features of the candidates that can be suggested: not merged away, owned (or not, per `owned`). */
type Features = Omit<Candidate, 'owned' | 'related' | 'coListened' | 'score'>

async function features(userId: string, ids: readonly string[], owned: boolean): Promise<Features[]> {
  if (ids.length === 0) return []
  const rows = await db.execute<Features>(sql`
    select r.id, r.primary_artist_id as "primaryArtistId", al.id as "albumId", al.year,
      array(select ra.artist_id::text from recording_artists ra where ra.recording_id = r.id order by ra.position) as "artistIds",
      coalesce(al.genres, '{}') || coalesce(ar.genres, '{}') as genres,
      coalesce(r.duration_ms, f.duration_ms, 0) as "durationMs",
      coalesce(r.popularity, 0)::float8 as popularity,
      exists (select 1 from likes l where l.user_id = ${userId} and l.entity_type = 'recording' and l.entity_id = r.id) as liked,
      exists (select 1 from likes l where l.user_id = ${userId} and l.entity_type = 'artist' and l.entity_id = r.primary_artist_id) as "likedArtist",
      exists (select 1 from likes l where l.user_id = ${userId} and l.entity_type = 'album' and l.entity_id = al.id) as "likedAlbum",
      exists (
        select 1 from plays p where p.recording_id = r.id and p.user_id = ${userId} and p.started_at > now() - ${`${RECENT_HOURS} hours`}::interval
      ) as "recentlyPlayed"
    from unnest(${uuidArray(ids)}) c(id)
    join recordings r on r.id = c.id and r.merged_into_id is null
    left join lateral (
      select mf.id, mf.album_id, mf.duration_ms from media_files mf
      where mf.recording_id = r.id and mf.missing_since is null order by mf.album_id is null, mf.added_at, mf.id limit 1
    ) f on true
    left join albums al on al.id = coalesce(f.album_id, ${albumOf('r.id')})
    left join artists ar on ar.id = r.primary_artist_id
    where (f.id is not null) = ${owned}
    order by r.id`)
  return rows.map(withLead)
}

/** The candidate's score and whether it is related to the seeds (see the top of this file). */
function score(candidate: Omit<Candidate, 'score' | 'related'>, profile: Profile, random: () => number): { score: number; related: boolean } {
  const keys = [...new Set(candidate.genres.map(genreKey))]
  const genreDot = keys.reduce((sum, key) => sum + (profile.genres.get(key) ?? 0), 0)
  const genre = keys.length && profile.genreNorm ? genreDot / (Math.sqrt(keys.length) * profile.genreNorm) : 0
  const year = candidate.year
  const era = year && profile.years.length ? Math.max(0, 1 - Math.min(...profile.years.map((seed) => Math.abs(seed - year))) / 10) : 0
  const sameArtist = candidate.artistIds.some((id) => profile.artists.has(id))
  const similar = Math.max(0, ...candidate.artistIds.map((id) => profile.similar.get(id) ?? 0))
  const radio = profile.radio.get(candidate.id) ?? 0
  const coListened = Math.min(1, Math.max(0, candidate.coListened - 1) / (CO_LISTENED_FULL - 1))
  const related = sameArtist || similar > 0 || radio > 0 || genre >= GENRE_RELATED || coListened > 0
  const total = weights.sameArtist * Number(sameArtist)
    + weights.similarArtist * similar
    + weights.radio * radio
    + weights.genre * genre
    + weights.era * era
    + weights.coListened * coListened
    + weights.liked * Number(candidate.liked)
    + weights.likedArtist * Number(candidate.likedArtist)
    + weights.likedAlbum * Number(candidate.likedAlbum)
    + weights.popularity * candidate.popularity
    + weights.recentlyPlayed * Number(candidate.recentlyPlayed)
    + weights.noise * random()
  return { score: total, related }
}

type Placed = { artistId: string | null; albumId: string | null; bySeedArtist: boolean }

/** Variety limits per window, from strict to none. */
const levels = [
  { perArtist: 2, perAlbum: 1, bySeedArtists: 3, backToBack: false },
  { perArtist: 3, perAlbum: 2, bySeedArtists: WINDOW, backToBack: false },
  { perArtist: WINDOW, perAlbum: WINDOW, bySeedArtists: WINDOW, backToBack: true },
] as const

/**
 * The order in which candidates are tried for each pick; the next step is used only when
 * nothing fits. A related track that bends the variety rules a little beats an unrelated
 * one: a radio heavy on similar artists is still that radio, one padded with whatever the
 * server holds is not. Unrelated tracks only fill a batch up to `FILL_UP_TO`.
 */
const steps: { related: boolean; level: (typeof levels)[number] }[] = [
  { related: true, level: levels[0] },
  { related: true, level: levels[1] },
  { related: false, level: levels[0] },
  { related: false, level: levels[1] },
  { related: true, level: levels[2] },
  { related: false, level: levels[2] },
]

/**
 * How many picks a batch may reach with unrelated candidates. Past it a batch ends early
 * instead: a radio that runs out continues through autoplay, seeded by its own last
 * (related) tracks, which finds more like them. A short library still gets a full window.
 */
export const FILL_UP_TO = WINDOW

function fits(candidate: Candidate, placed: Placed, recent: Placed[], level: (typeof levels)[number]): boolean {
  const last = recent.at(-1)
  if (!level.backToBack && last && placed.artistId && last.artistId === placed.artistId) return false
  const count = (match: (one: Placed) => boolean) => recent.filter(match).length
  if (placed.artistId && count((one) => one.artistId === placed.artistId) >= level.perArtist) return false
  if (candidate.albumId && count((one) => one.albumId === candidate.albumId) >= level.perAlbum) return false
  return !placed.bySeedArtist || count((one) => one.bySeedArtist) < level.bySeedArtists
}

/**
 * Picks up to `limit` candidates in score order under the variety rules and `steps`,
 * continuing after `history`. The first pick goes to an owned candidate within
 * `INSTANT_MARGIN` of the best one, when there is one.
 */
function pick(ranked: Candidate[], history: Placed[], profile: Profile, limit: number): Candidate[] {
  const placedOf = (candidate: Candidate): Placed => ({
    artistId: candidate.primaryArtistId ?? candidate.artistIds[0] ?? null,
    albumId: candidate.albumId,
    bySeedArtist: candidate.artistIds.some((id) => profile.artists.has(id)),
  })
  const sequence = [...history]
  const left = [...ranked]
  const chosen: Candidate[] = []
  while (chosen.length < limit && left.length > 0) {
    const recent = sequence.slice(-(WINDOW - 1))
    let index = -1
    for (const step of steps) {
      if (!step.related && chosen.length >= FILL_UP_TO) continue
      const allowed = (candidate: Candidate) => candidate.related === step.related && fits(candidate, placedOf(candidate), recent, step.level)
      index = left.findIndex(allowed)
      if (index < 0) continue
      if (chosen.length === 0 && !left[index]!.owned) {
        const best = left[index]!.score
        // `left` is in score order: nothing after `index` scores higher than the best.
        const instant = left.findIndex((candidate, at) => at > index && candidate.owned && candidate.score >= best - INSTANT_MARGIN && allowed(candidate))
        if (instant >= 0) index = instant
      }
      break
    }
    if (index < 0) break
    const [next] = left.splice(index, 1)
    chosen.push(next!)
    sequence.push(placedOf(next!))
  }
  return chosen
}

/**
 * Up to `limit` tracks to play after the seeds, best first, as queue seeds: owned tracks
 * `ready`, on-demand ones (for a user who may have tracks fetched) `preparing`. Never
 * returns a seed or an excluded track. See the top of this file for the method.
 */
export async function suggest(request: SuggestRequest, options: SuggestOptions = {}): Promise<QueueSeed[]> {
  const random = options.random ?? Math.random
  if (request.limit <= 0) return []
  const [seeds, requester] = await Promise.all([describe(request.seeds), isRequester(request.userId)])
  const timeoutMs = options.similarTimeoutMs ?? SIMILAR_TIMEOUT_MS
  const started = Date.now()
  // Deezer's radio first: it writes rows for the artists it names, so the similar artists
  // looked up next map to them instead of being left out for not being in the catalog.
  const radio = seeds.length ? await radioOf(seeds, timeoutMs) : new Map<string, number>()
  const similar = seeds.length ? await similarTo(seeds, Math.max(MIN_SIMILAR_WAIT_MS, timeoutMs - (Date.now() - started))) : new Map<string, number>()
  const profile = profileOf(seeds, similar, radio, await artistsOf([...radio.keys()]))
  const banned = new Set([...request.seeds, ...request.exclude])
  // Seeds count towards the artist and album limits, not the limit on seed artists.
  const history: Placed[] = seeds.map((seed) => ({
    artistId: seed.primaryArtistId ?? seed.artistIds[0] ?? null,
    albumId: seed.albumId,
    bySeedArtist: false,
  }))
  const salt = Math.floor(random() * 2 ** 32)

  const found = await Promise.all((requester ? [true, false] : [true]).map(async (owned) => {
    const near = await gather(request.userId, profile, owned, salt)
    let rows = await features(request.userId, [...near.keys()].filter((id) => !banned.has(id)), owned)
    if (!owned) {
      const available = await onDemandRecordings(rows.map((candidate) => candidate.id))
      rows = rows.filter((candidate) => available.has(candidate.id))
    }
    return rows.map((candidate) => ({ ...candidate, owned, coListened: near.get(candidate.id) ?? 0 }))
  }))
  const ranked = found.flat()
    .map((candidate) => ({ ...candidate, ...score(candidate, profile, random) }))
    .sort((a, b) => b.score - a.score)
  return pick(ranked, history, profile, request.limit).map((candidate) => ({
    trackId: candidate.id,
    albumId: candidate.albumId,
    durationMs: candidate.durationMs,
    state: candidate.owned ? 'ready' : 'preparing',
  }))
}
