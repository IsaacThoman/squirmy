import { queryKeys } from '@squirmy/contracts'
import { sql } from 'drizzle-orm'
import { db } from '../../database/client.js'
import { lyrics } from '../../database/schema.js'
import { getServerSettings } from '../../lib/settings.js'
import { lrclib } from '../metadata/index.js'
import { changed, currentId, day } from './rows.js'

/** A lookup that found nothing is not repeated for this long. */
const retryMissAfterMs = 30 * day

/**
 * Looks a recording's lyrics up on LRCLIB by title, artist, album and duration when it
 * has none: synced and plain text are stored, or a `none` marker so the lookup is not
 * repeated for 30 days. Lyrics from the user's files are never replaced.
 */
export async function fetchLyrics(id: string): Promise<void> {
  if (!(await getServerSettings()).lrclibEnabled) return
  const recordingId = await currentId('recording', id)
  if (!recordingId) return
  // The album of a present file, else of any release the recording is on.
  const [row] = await db.execute<{ title: string; artist: string; durationMs: number | null; album: string | null; source: string | null; fetchedAt: Date | null }>(sql`
    select r.title, r.artist_credit as artist, l.source, l.fetched_at as "fetchedAt",
      coalesce(r.duration_ms, (select max(f.duration_ms) from media_files f where f.recording_id = r.id)) as "durationMs",
      coalesce(
        (select a.title from media_files f join albums a on a.id = f.album_id where f.recording_id = r.id and f.missing_since is null order by f.id limit 1),
        (select a.title from release_tracks rt join releases rl on rl.id = rt.release_id join albums a on a.id = rl.album_id where rt.recording_id = r.id order by rt.id limit 1)
      ) as album
    from recordings r left join lyrics l on l.recording_id = r.id
    where r.id = ${recordingId}`)
  if (!row || !row.durationMs) return
  if (row.source && (row.source !== 'none' || Date.now() - new Date(row.fetchedAt!).getTime() < retryMissAfterMs)) return

  const found = await lrclib.getLyrics({ title: row.title, artist: row.artist, ...(row.album ? { album: row.album } : {}), durationMs: row.durationMs })
  const values = found
    ? { synced: found.synced, plain: found.plain, instrumental: found.instrumental, source: 'lrclib', fetchedAt: new Date() }
    : { synced: null, plain: null, instrumental: false, source: 'none', fetchedAt: new Date() }
  await db.insert(lyrics).values({ recordingId, ...values })
    .onConflictDoUpdate({ target: lyrics.recordingId, set: values, setWhere: sql`${lyrics.source} = 'none'` })
  if (found) await changed([queryKeys.lyrics(recordingId), queryKeys.track(recordingId)])
}
