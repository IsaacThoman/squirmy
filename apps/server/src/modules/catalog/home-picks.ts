/**
 * Home's rails that are made ahead of time, once a day per user: the mixes (radio's
 * `makeMixes`), Because you listened to (radio's `becauseYouListened`), Your top artists,
 * Rediscover, and when in the day the user plays each artist, which orders Home by the time of
 * day. They look up similar artists from outside services and scan months to years of plays,
 * which no Home request should wait for, and they should not change while the user looks at them.
 *
 *   catalog.home-picks      { userId }  makes the user's picks and mixes, then refreshes their Home
 *   catalog.home-picks-all  daily at 05:00: queues the users who played something in the last 90 days
 *
 * Home also queues a user's run when theirs are due (`queueHomePicksWhenDue`), so a new
 * listener's first mixes do not wait for the next morning.
 */
import { queryKeys } from '@squirmy/contracts'
import { eq, sql } from 'drizzle-orm'
import { db } from '../../database/client.js'
import { homePicks } from '../../database/schema.js'
import { enqueue, enqueueMany } from '../../jobs/index.js'
import { invalidate } from '../../realtime/index.js'
import { becauseYouListened, makeMixes, saveMixes } from '../radio/index.js'
import { completedPlay, placeholderArtist, playArtist } from './sql.js'

export type HomePicksJob = { userId: string }

export type HomePicks = typeof homePicks.$inferSelect

/** Rediscover: songs with at least this many completed plays… */
const REDISCOVER_MIN_PLAYS = 3
/** …between these many months ago… */
const REDISCOVER_FROM_MONTHS = 24
const REDISCOVER_TO_MONTHS = 6
/** …and none in this many days. */
const REDISCOVER_QUIET_DAYS = 90
const REDISCOVER_KEPT = 40
/** Your top artists: of this many days. */
const TOP_ARTIST_DAYS = 30
const TOP_ARTISTS = 20
/** The time-of-day profile: the plays of this many days, for this many of the most played artists. */
const HOURLY_DAYS = 90
const HOURLY_ARTISTS = 100
/** A run that made no mixes is due again after this long, once the user has played more. */
const RETRY_EMPTY_MS = 60 * 60_000

/** Today's date on the server, the day mixes are made for. */
export const today = () => new Date().toISOString().slice(0, 10)

/**
 * Songs the user played a lot six to 24 months ago and not in the last 90 days, most played
 * then first: forgotten favourites. Their albums are the ones they were last played from.
 */
export async function rediscoverTracks(userId: string): Promise<{ id: string; albumId: string | null }[]> {
  return db.execute<{ id: string; albumId: string | null }>(rediscoverQuery(userId))
}

export const rediscoverQuery = (userId: string) => sql`
    select p.recording_id as id, (array_agg(p.album_id order by p.started_at desc))[1] as "albumId"
    from plays p
    where p.user_id = ${userId} and p.completed and not p.skipped
      and p.started_at >= now() - make_interval(months => ${REDISCOVER_FROM_MONTHS})
      and p.started_at < now() - make_interval(months => ${REDISCOVER_TO_MONTHS})
    group by p.recording_id
    having count(*) >= ${REDISCOVER_MIN_PLAYS} and not exists (
      select 1 from plays recent
      where recent.user_id = ${userId} and recent.recording_id = p.recording_id and not recent.skipped
        and recent.started_at > now() - make_interval(days => ${REDISCOVER_QUIET_DAYS})
    )
    order by count(*) desc, max(p.started_at) desc, p.recording_id limit ${REDISCOVER_KEPT}`

/** The artists of the user's most completed plays over the last 30 days, most first. */
export const topArtistsQuery = (userId: string) => sql`
  select a.id from plays p join recordings r on r.id = p.recording_id join artists a on a.id = ${playArtist('r')}
  where p.user_id = ${userId} and ${completedPlay('p')} and p.started_at > now() - make_interval(days => ${TOP_ARTIST_DAYS})
    and a.merged_into_id is null and not ${placeholderArtist('a')}
  group by a.id order by count(*) desc, max(p.started_at) desc, a.id limit ${TOP_ARTISTS}`

/** The user's completed plays of the last 90 days by artist and UTC hour. */
export const hourlyQuery = (userId: string) => sql`
  select ${playArtist('r')} as id, extract(hour from p.started_at at time zone 'UTC')::int as hour, count(*)::int as plays
  from plays p join recordings r on r.id = p.recording_id
  where p.user_id = ${userId} and ${completedPlay('p')} and p.started_at > now() - make_interval(days => ${HOURLY_DAYS})
  group by 1, 2`

/** Plays per UTC hour (24 numbers) of the user's most played artists. */
export async function hourlyListening(userId: string): Promise<Record<string, number[]>> {
  const byArtist = new Map<string, number[]>()
  for (const row of await db.execute<{ id: string | null; hour: number; plays: number }>(hourlyQuery(userId))) {
    if (!row.id) continue
    const hours = byArtist.get(row.id) ?? Array.from({ length: 24 }, () => 0)
    hours[row.hour] = row.plays
    byArtist.set(row.id, hours)
  }
  const total = (hours: number[]) => hours.reduce((sum, plays) => sum + plays, 0)
  return Object.fromEntries([...byArtist].sort((a, b) => total(b[1]) - total(a[1])).slice(0, HOURLY_ARTISTS))
}

/** Makes and stores the user's picks and mixes for today, then tells their apps Home changed. */
export async function makeHomePicks(userId: string) {
  const day = today()
  const [made, because, top, rediscover, hourly] = await Promise.all([
    makeMixes(userId, day),
    becauseYouListened(userId, day),
    db.execute<{ id: string }>(topArtistsQuery(userId)),
    rediscoverTracks(userId),
    hourlyListening(userId),
  ])
  await saveMixes(userId, made)
  const values = {
    generatedAt: new Date(),
    becauseArtistId: because?.artistId ?? null,
    becauseArtistIds: because?.artistIds ?? [],
    topArtistIds: top.map((row) => row.id),
    rediscover,
    hourly,
  }
  await db.insert(homePicks).values({ userId, ...values }).onConflictDoUpdate({ target: homePicks.userId, set: values })
  await invalidate({ user: userId }, [queryKeys.home()])
}

/**
 * Whether the user's picks should be made again: never made, made before today, or made with
 * no mixes over an hour ago and played since. Only a user with a completed play has any.
 */
export async function homePicksDue(userId: string, picks: HomePicks | undefined, mixCount: number): Promise<boolean> {
  const [row] = await db.execute<{ due: boolean }>(sql`
    select exists (
      select 1 from plays p where p.user_id = ${userId} and p.completed and not p.skipped
        ${picks ? sql`and p.started_at > ${picks.generatedAt.toISOString()}::timestamptz` : sql``}
    ) as due`)
  if (!row?.due || !picks) return Boolean(row?.due)
  if (picks.generatedAt.toISOString().slice(0, 10) < today()) return true
  return mixCount === 0 && Date.now() - picks.generatedAt.getTime() > RETRY_EMPTY_MS
}

/** Queues the user's run when it is due. A process without the job system leaves it to the daily run. */
export async function queueHomePicksWhenDue(userId: string, picks: HomePicks | undefined, mixCount: number) {
  if (!await homePicksDue(userId, picks, mixCount)) return
  await enqueue<HomePicksJob>('catalog.home-picks', { userId }, { singletonKey: userId }).catch(() => {})
}

export async function homePicksOf(userId: string): Promise<HomePicks | undefined> {
  const [row] = await db.select().from(homePicks).where(eq(homePicks.userId, userId))
  return row
}

/** Queues today's run for every user who played something in the last 90 days and has none yet. */
export async function queueDailyHomePicks() {
  const users = await db.execute<{ id: string }>(sql`
    select u.id from users u
    where u.disabled_at is null
      and exists (select 1 from plays p where p.user_id = u.id and p.completed and p.started_at > now() - interval '90 days')
      and not exists (select 1 from home_picks hp where hp.user_id = u.id and hp.generated_at >= ${`${today()}T00:00:00Z`}::timestamptz)`)
  await enqueueMany<HomePicksJob>('catalog.home-picks', users.map((user) => ({ data: { userId: user.id }, singletonKey: user.id, priority: -1 })))
}
