import { sql } from 'drizzle-orm'
import { db } from '../../database/client.js'
import { completedPlay, placeholderArtist, playArtist, uuidArray } from '../catalog/sql.js'
import { similarArtists } from './similar.js'

/** The user's most played artists of this many days take turns as the seed, one a day. */
const SEED_DAYS = 30
const SEED_CHOICES = 3
/** Fewest similar artists for the rail to show. */
const MIN_ARTISTS = 3
const MAX_ARTISTS = 20

export type BecauseYouListened = { artistId: string; artistIds: string[] }

/**
 * Home's Because you listened to: one of the artists the user played most over the last
 * month (they take turns, one a day, by `day`), and the artists radio's similar-artist data
 * (similar.ts) ranks closest to it that have music on the server, so each card plays. Null
 * when the user played no one lately, or too few similar artists have music here.
 */
export async function becauseYouListened(userId: string, day: string): Promise<BecauseYouListened | null> {
  const top = await db.execute<{ id: string }>(sql`
    select a.id from plays p join recordings r on r.id = p.recording_id
    join artists a on a.id = ${playArtist('r')}
    where p.user_id = ${userId} and ${completedPlay('p')} and p.started_at > now() - make_interval(days => ${SEED_DAYS})
      and a.merged_into_id is null and not ${placeholderArtist('a')}
    group by a.id order by count(*) desc, max(p.started_at) desc, a.id limit ${SEED_CHOICES}`)
  if (top.length === 0) return null
  const dayNumber = Math.floor(Date.parse(`${day}T00:00:00Z`) / 86_400_000)
  // Every choice is tried, today's first, so a seed whose similar artists are not here gives way to the next.
  for (let turn = 0; turn < top.length; turn++) {
    const seed = top[(dayNumber + turn) % top.length]!.id
    const similar = await similarArtists(seed, { limit: 40 }).catch(() => [])
    if (similar.length < MIN_ARTISTS) continue
    const withMusic = await db.execute<{ id: string }>(sql`
      select s.id from unnest(${uuidArray(similar.map((one) => one.artistId))}) with ordinality s(id, n)
      where s.id <> ${seed} and exists (
        select 1 from album_artists aa join media_files mf on mf.album_id = aa.album_id
        where aa.artist_id = s.id and mf.missing_since is null and mf.recording_id is not null
      )
      order by s.n limit ${MAX_ARTISTS}`)
    if (withMusic.length >= MIN_ARTISTS) return { artistId: seed, artistIds: withMusic.map((row) => row.id) }
  }
  return null
}
