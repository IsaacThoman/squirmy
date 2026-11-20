import { sql } from 'drizzle-orm'
import { db } from '../database/client.js'

export type LargeLibrary = {
  albums: number
  tracksPerAlbum: number
  artists: number
  /** Every n-th album has no files (catalog only); the rest are fully owned. */
  unownedEvery: number
  /** Plays and likes written for `userId`. */
  userId: string
  plays: number
  likes: number
}

const genres = ['Rock', 'Jazz', 'Ambient', 'Folk', 'Electronic', 'Hip Hop', 'Classical', 'Pop', 'Metal', 'Soul', 'Blues', 'Punk']

/**
 * Seeds a synthetic library in a few set-based statements: artists, albums with one
 * release each, recordings, credits, files (`added_at` spread over time, many sharing a
 * timestamp per album), plays and likes. 10,000 albums with 15 tracks take a few seconds.
 */
export async function seedLargeLibrary(options: LargeLibrary) {
  const { albums, tracksPerAlbum, artists, unownedEvery, userId, plays, likes } = options
  await db.transaction(async (tx) => {
    await tx.execute(sql`
      create temp table seed_artists on commit drop as
      select i, gen_random_uuid() as id, case when i % 7 = 0 then 'The ' else '' end || 'Artist ' || md5(i::text) as name
      from generate_series(1, ${artists}) i`)
    await tx.execute(sql`
      insert into artists (id, name, sort_name, name_key, detail_level)
      select id, name, name, lower(name), 1 from seed_artists`)
    await tx.execute(sql`
      create temp table seed_albums on commit drop as
      select i, gen_random_uuid() as id, gen_random_uuid() as release_id, 1 + i % ${artists} as artist_i,
        'Album ' || md5('album' || i) as title, 1960 + i % 66 as year,
        array[(${sql.raw(`array[${genres.map((genre) => `'${genre}'`).join(',')}]`)})[1 + i % ${genres.length}]] as genres
      from generate_series(1, ${albums}) i`)
    await tx.execute(sql`
      insert into albums (id, title, artist_credit, primary_artist_id, type, year, release_date, title_key, match_key, genres, canonical_release_id, detail_level)
      select al.id, al.title, ar.name, ar.id, 'album', al.year, al.year::text, lower(al.title), lower(ar.name) || '|' || lower(al.title), al.genres, al.release_id, 2
      from seed_albums al join seed_artists ar on ar.i = al.artist_i`)
    await tx.execute(sql`
      insert into album_artists (album_id, position, artist_id, credited_name)
      select al.id, 0, ar.id, ar.name from seed_albums al join seed_artists ar on ar.i = al.artist_i`)
    await tx.execute(sql`
      insert into releases (id, album_id, title, release_date, track_count, detail_level)
      select release_id, id, title, year::text, ${tracksPerAlbum}, 2 from seed_albums`)
    await tx.execute(sql`
      create temp table seed_tracks on commit drop as
      select al.i as album_i, al.id as album_id, al.release_id, al.artist_i, t as position,
        gen_random_uuid() as recording_id, gen_random_uuid() as release_track_id, 'Track ' || md5(al.i || '-' || t) as title
      from seed_albums al cross join generate_series(1, ${tracksPerAlbum}) t`)
    await tx.execute(sql`
      insert into recordings (id, title, artist_credit, primary_artist_id, duration_ms, title_key, match_key, popularity)
      select st.recording_id, st.title, ar.name, ar.id, 120000 + st.position * 1000, lower(st.title), lower(ar.name) || '|' || lower(st.title), random()
      from seed_tracks st join seed_artists ar on ar.i = st.artist_i`)
    await tx.execute(sql`
      insert into recording_artists (recording_id, position, artist_id, credited_name)
      select st.recording_id, 0, ar.id, ar.name from seed_tracks st join seed_artists ar on ar.i = st.artist_i`)
    await tx.execute(sql`
      insert into release_tracks (id, release_id, disc, position, recording_id, title, duration_ms)
      select release_track_id, release_id, 1, position, recording_id, title, 120000 + position * 1000 from seed_tracks`)
    await tx.execute(sql`
      with root as (
        insert into library_roots (id, name, path) values (gen_random_uuid(), 'Seed', '/seed/' || gen_random_uuid()) returning id
      )
      insert into media_files (id, root_id, rel_path, size, mtime, container, codec, lossless, duration_ms, recording_id, release_track_id, release_id, album_id, match_status, probe_stage, added_at)
      select gen_random_uuid(), root.id, st.album_i || '/' || st.position || '.flac', 1000000, now(), 'flac', 'flac', true, 120000,
        st.recording_id, st.release_track_id, st.release_id, st.album_id, 'unmatched', 1,
        -- Albums arrive one per minute; all files of an album share the timestamp.
        timestamptz '2026-01-01' + st.album_i * interval '1 minute'
      from seed_tracks st cross join root
      where st.album_i % ${unownedEvery} <> 0`)
    await tx.execute(sql`
      insert into plays (id, user_id, recording_id, album_id, started_at, ms_played, completed)
      select gen_random_uuid(), ${userId}, st.recording_id, st.album_id, now() - n * interval '3 minutes', 60000, true
      from generate_series(1, ${plays}) n
      join seed_tracks st on st.album_i = 1 + (n * 7919) % ${albums} and st.position = 1 + n % ${tracksPerAlbum}`)
    await tx.execute(sql`
      insert into likes (user_id, entity_type, entity_id, created_at)
      select ${userId}, 'recording', st.recording_id, now() - n * interval '1 hour'
      from generate_series(1, ${likes}) n
      join seed_tracks st on st.album_i = 1 + (n * 104729) % ${albums} and st.position = 1
      on conflict do nothing`)
  })
  await db.execute(sql`analyze`)
}
