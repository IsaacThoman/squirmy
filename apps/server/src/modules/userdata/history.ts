import type { HistoryPage, PageQuery } from '@squirmy/contracts'
import { sql } from 'drizzle-orm'
import { db } from '../../database/client.js'
import { after, cursorKeys, orderBy, toPage, type Ordering } from '../catalog/pagination.js'
import { isoTime } from '../catalog/sql.js'
import { alignedTrackSummaries } from '../catalog/summaries.js'

const historyOrdering: Ordering = {
  name: 'history',
  keys: [
    { expression: sql.raw('p.started_at'), type: 'timestamptz', descending: true },
    { expression: sql.raw('p.id'), type: 'uuid', descending: true },
  ],
}

/**
 * One page of the user's plays, newest first, each track shown in the album it was
 * played from. A play is left out when the next play was the same track, so a track on
 * repeat appears once, at its latest play. The check looks at the neighbouring play
 * itself, so it holds across page boundaries.
 */
export async function listHistory(userId: string, query: PageQuery): Promise<HistoryPage> {
  const rows = await db.execute<{ recordingId: string; albumId: string | null; playedAt: string; cursorKeys: string[] }>(sql`
    select p.recording_id as "recordingId", p.album_id as "albumId", ${isoTime('p.started_at')} as "playedAt", ${cursorKeys(historyOrdering)}
    from plays p
    where p.user_id = ${userId} and not p.skipped and ${after(historyOrdering, query.cursor)}
      and p.recording_id is distinct from (
        select later.recording_id from plays later
        where later.user_id = p.user_id and not later.skipped and (later.started_at, later.id) > (p.started_at, p.id)
        order by later.started_at, later.id limit 1
      )
    order by ${orderBy(historyOrdering)} limit ${query.limit + 1}`)
  const plays = rows.slice(0, query.limit)
  const tracks = await alignedTrackSummaries(userId, plays.map((play) => ({ id: play.recordingId, albumId: play.albumId })))
  const items = plays.flatMap((play, index) => {
    const track = tracks[index]
    return track ? [{ playedAt: play.playedAt, track }] : []
  })
  return toPage(historyOrdering, rows, query.limit, items)
}
