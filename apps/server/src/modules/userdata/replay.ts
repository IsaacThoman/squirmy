import type { ReplayQuery, ReplayStats } from '@squirmy/contracts'
import { sql } from 'drizzle-orm'
import { db } from '../../database/client.js'
import { badRequest } from '../../lib/errors.js'
import { isoTime } from '../catalog/sql.js'
import { albumSummaries, alignedTrackSummaries, artistSummaries } from '../catalog/summaries.js'

type StatsRows = Omit<ReplayStats, 'tracks' | 'albums' | 'artists'> & {
  tracks: (Omit<ReplayStats['tracks'][number], 'track'> & { albumId: string | null })[]
  albums: Omit<ReplayStats['albums'][number], 'album'>[]
  artists: Omit<ReplayStats['artists'][number], 'image'>[]
}

export async function getReplay(userId: string, query: ReplayQuery): Promise<ReplayStats> {
  // Compare complete previous calendar periods. Use wall-clock dates before converting
  // boundaries to instants so daylight saving changes don't shift the day or week.
  const unit = query.period === 'review' || query.period === 'all' ? 'year' : query.period
  const start = query.period === 'all' ? sql`null::timestamp`
    : query.period === 'review' ? sql`make_date(${query.year}::int, 1, 1)::timestamp`
      : sql`date_trunc(${unit}, now() at time zone ${query.tz})`
  const [zone] = await db.execute<{ year: number }>(sql`
    select extract(year from now() at time zone name)::int as year
    from pg_timezone_names where lower(name) = lower(${query.tz})`)
  // Node and Postgres sometimes ship different versions of the time-zone database.
  if (!zone) throw badRequest('This server does not recognize that time zone', 'invalid_time_zone')
  if (query.period === 'review' && query.year! > zone.year) throw badRequest('Choose this year or an earlier year', 'invalid_review_year')

  const [row] = await db.execute<{ stats: StatsRows }>(replayStatement(userId, query.tz, unit, start))
  const stats = row!.stats
  const [tracks, albums, artists] = await Promise.all([
    alignedTrackSummaries(userId, stats.tracks.flatMap(({ id, albumId }) => id ? [{ id, albumId }] : [])),
    albumSummaries(stats.albums.flatMap(({ id }) => id ? [id] : [])),
    artistSummaries(stats.artists.flatMap(({ id }) => id ? [id] : [])),
  ])
  const byAlbum = new Map(albums.map((album) => [album.id, album]))
  const imageByArtist = new Map(artists.map((artist) => [artist.id, artist.image]))
  let trackIndex = 0
  return {
    ...stats,
    tracks: stats.tracks.map(rank => ({
      key: rank.key, id: rank.id, name: rank.name, artist: rank.artist, plays: rank.plays, msPlayed: rank.msPlayed,
      track: rank.id ? tracks[trackIndex++] ?? null : null,
    })),
    artists: stats.artists.map((rank) => ({ ...rank, image: rank.id ? imageByArtist.get(rank.id) ?? null : null })),
    albums: stats.albums.map((rank) => ({ ...rank, album: rank.id ? byAlbum.get(rank.id) ?? null : null })),
  }
}

// Aggregate listening rows before joining artist credits and genres. A track appearing
// on several releases or with several artists contributes only once to the headline totals.
export function replayStatement(userId: string, tz: string, unit: string, start: ReturnType<typeof sql>) {
  return sql`
    with bounds as not materialized (
      select wall_start at time zone ${tz} as starts,
        least(now(), (wall_start + span) at time zone ${tz}) as ends,
        (wall_start - span) at time zone ${tz} as previous_starts
      from (select ${start} as wall_start, ('1 ' || ${unit}::text)::interval as span) local_bounds
    ),
    catalog_plays as not materialized (
      select p.id, p.recording_id, p.album_id, p.client, p.started_at, p.ms_played
      from bounds b
      join plays p on p.user_id = ${userId} and not p.skipped
        and p.started_at >= coalesce(b.previous_starts, '-infinity')
        and p.started_at < b.ends
    ),
    unmatched_plays as not materialized (
      select p.started_at, coalesce(p.ms_played, 0) as ms_played, p.track_key, p.artist_key, p.album_key, p.title, p.artist, p.album
      from bounds b
      join history_imported_plays p on p.user_id = ${userId}
        and p.play_id is null and not p.skipped
        and p.started_at >= coalesce(b.previous_starts, '-infinity')
        and p.started_at < b.ends
    ),
    events as not materialized (
      select started_at, ms_played from catalog_plays
      union all
      select started_at, ms_played from unmatched_plays
    ),
    grouped as (
      select p.recording_id, p.album_id, null::text as track_key, null::text as artist_key, i.album_key,
        null::text as title, min(i.artist) as artist, min(i.album) as album,
        sum(p.ms_played)::float8 as "msPlayed", count(*)::int as plays
      from catalog_plays p cross join bounds b
      left join history_imported_plays i on p.client = 'history-import' and p.album_id is null and i.play_id = p.id
      where p.started_at >= coalesce(b.starts, '-infinity')
      group by p.recording_id, p.album_id, i.album_key
      union all
      select null, null, p.track_key, p.artist_key, p.album_key, min(p.title), min(p.artist), min(p.album),
        sum(p.ms_played)::float8, count(*)::int
      from unmatched_plays p cross join bounds b
      where p.started_at >= coalesce(b.starts, '-infinity')
      group by p.track_key, p.artist_key, p.album_key
    ),
    recording_first as (
      select recording_id, min(started_at) as first_at
      from plays where user_id = ${userId} and not skipped
      group by recording_id
    ),
    credits as materialized (
      select r.id as recording_id, a.id as artist_id,
        coalesce(a.id::text, 'text:' || split_part(r.match_key, '|', 1)) as key,
        coalesce(a.name, r.artist_credit) as name, a.genres, f.first_at
      from recording_first f
      join recordings r on r.id = f.recording_id
      left join lateral (
        select distinct artist_id from recording_artists where recording_id = r.id
      ) credit on true
      left join artists a on a.id = coalesce(credit.artist_id, r.primary_artist_id)
    ),
    unmatched_artist_first as (
      select artist_key, min(artist) as name, min(started_at) as first_at
      from history_imported_plays where user_id = ${userId} and play_id is null and not skipped
      group by artist_key
    ),
    imported_credits as (
      select f.artist_key, chosen.id as artist_id,
        coalesce(chosen.id::text, 'text:' || f.artist_key) as key,
        coalesce(chosen.name, f.name) as name, chosen.genres, f.first_at
      from unmatched_artist_first f
      left join lateral (
        select a.id, a.name, a.genres, count(*) over () as ties
        from (select id, name, genres from artists where name_key = f.artist_key and merged_into_id is null limit 2) a
      ) chosen on chosen.ties = 1
    ),
    first_artists as (
      select key, artist_id, min(name) as name, min(first_at) as first_at
      from (
        select key, artist_id, name, first_at from credits
        union all
        select key, artist_id, name, first_at from imported_credits
      ) all_artists
      group by key, artist_id
    ),
    discovered as (
      select key, artist_id as id, name, ${isoTime('first_at')} as "firstPlayedAt"
      from first_artists cross join bounds b
      where first_at >= coalesce(b.starts, '-infinity') and first_at < b.ends
      order by first_at, key
    ),
    track_ranks as (
      select coalesce(g.recording_id::text, 'text:' || g.track_key) as key,
        g.recording_id as id, coalesce(r.title, min(g.title)) as name,
        coalesce(r.artist_credit, min(g.artist)) as artist,
        (array_agg(g.album_id order by g.plays desc, g.album_id nulls last))[1] as "albumId",
        sum(g.plays)::int as plays, sum(g."msPlayed") as "msPlayed"
      from grouped g left join recordings r on r.id = g.recording_id
      group by g.recording_id, g.track_key, r.title, r.artist_credit
      order by plays desc, "msPlayed" desc, key
    ),
    artist_ranks as (
      select coalesce(c.key, i.key) as key, coalesce(c.artist_id, i.artist_id) as id,
        coalesce(c.name, i.name) as name, null::text as artist,
        sum(g.plays)::int as plays, sum(g."msPlayed") as "msPlayed"
      from grouped g left join credits c on c.recording_id = g.recording_id
      left join imported_credits i on i.artist_key = g.artist_key
      group by 1, 2, 3
      order by plays desc, "msPlayed" desc, key
    ),
    album_ranks as (
      select coalesce(g.album_id::text, 'text:' || g.album_key) as key, g.album_id as id,
        coalesce(a.title, min(g.album)) as name, coalesce(a.artist_credit, min(g.artist)) as artist,
        sum(g.plays)::int as plays, sum(g."msPlayed") as "msPlayed"
      from grouped g left join albums a on a.id = g.album_id
      where g.album_id is not null or g.album_key is not null
      group by g.album_id, g.album_key, a.title, a.artist_credit
      order by plays desc, "msPlayed" desc, key
    ),
    artist_genres as (
      select recording_id, array_agg(genre.name) as names
      from credits c cross join lateral unnest(c.genres) as genre(name)
      group by recording_id
    ),
    genre_ranks as (
      select lower(genre.name) as key, null::uuid as id, min(genre.name) as name, null::text as artist,
        sum(g.plays)::int as plays, sum(g."msPlayed") as "msPlayed"
      from grouped g
      left join albums a on a.id = g.album_id
      left join artist_genres ag on ag.recording_id = g.recording_id
      cross join lateral (
        select distinct on (lower(name)) name
        from unnest(case when cardinality(a.genres) > 0 then a.genres else ag.names end) as labels(name)
        where name <> '' order by lower(name), name
      ) genre
      group by lower(genre.name)
      order by plays desc, "msPlayed" desc, key
    ),
    daily_hours as (
      select date_trunc('hour', started_at at time zone ${tz}) as wall_hour,
        count(*)::int as plays, sum(ms_played) as ms_played
      from events e cross join bounds b
      where e.started_at >= coalesce(b.starts, '-infinity')
      group by 1
    ),
    clock as (
      select extract(isodow from wall_hour)::int as weekday, extract(hour from wall_hour)::int as hour,
        sum(plays)::int as plays, sum(ms_played)::float8 as "msPlayed"
      from daily_hours group by 1, 2 order by 1, 2
    ),
    days as (
      select distinct wall_hour::date as day from daily_hours
    ),
    runs as (
      select max(day) as last_day, count(*)::int as length
      from (select day, day - row_number() over (order by day)::int as run from days) numbered
      group by run
    ),
    streak as (
      select coalesce(max(length), 0) as longest,
        coalesce(max(length) filter (where last_day >= ((b.ends - interval '1 microsecond') at time zone ${tz})::date - 1), 0) as current
      from runs cross join bounds b
    )
    select jsonb_build_object(
      'window', jsonb_build_object('start', ${isoTime('b.starts')}, 'end', ${isoTime('b.ends')}),
      'previous', case when b.previous_starts is not null then (
        select jsonb_build_object('start', ${isoTime('b.previous_starts')}, 'end', ${isoTime('b.starts')},
          'plays', count(*)::int, 'msPlayed', coalesce(sum(ms_played), 0)::float8)
        from events where started_at < b.starts
      ) end,
      'totals', jsonb_build_object(
        'plays', (select coalesce(sum(plays), 0)::int from daily_hours),
        'msPlayed', (select coalesce(sum(ms_played), 0)::float8 from daily_hours),
        'tracks', (select count(*)::int from track_ranks),
        'artists', (select count(*)::int from artist_ranks),
        'albums', (select count(*)::int from album_ranks)
      ),
      'tracks', coalesce((select jsonb_agg(t) from (select * from track_ranks limit 10) t), '[]'),
      'artists', coalesce((select jsonb_agg(t) from (select * from artist_ranks limit 10) t), '[]'),
      'albums', coalesce((select jsonb_agg(t) from (select * from album_ranks limit 10) t), '[]'),
      'genres', coalesce((select jsonb_agg(t) from (select * from genre_ranks limit 10) t), '[]'),
      'clock', coalesce((select jsonb_agg(clock) from clock), '[]'),
      'streak', (select to_jsonb(streak) from streak),
      'discoveries', jsonb_build_object('count', (select count(*)::int from discovered),
        'artists', coalesce((select jsonb_agg(t) from (select * from discovered limit 10) t), '[]')),
      'firstYear', (select extract(year from min(first_at) at time zone ${tz})::int from first_artists)
    ) as stats from bounds b`
}
