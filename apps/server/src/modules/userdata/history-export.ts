import type { HistoryExportEntry, HistoryExportFormat } from '@squirmy/contracts'
import { sql } from 'drizzle-orm'
import { db } from '../../database/client.js'
import { isoTime } from '../catalog/sql.js'

type ExportPlay = HistoryExportEntry & { cursorAt: string }

const fields = [
  'id', 'startedAt', 'title', 'artist', 'album', 'recordingId', 'albumId',
  'msPlayed', 'completed', 'skipped', 'source', 'contextType', 'contextId',
] as const

function csv(value: string | number | boolean | null) {
  if (value === null) return ''
  if (typeof value !== 'string') return String(value)
  // Spreadsheet apps can interpret a quoted cell as a formula.
  const safe = /^[\s\uFEFF]*[=+@-]|^[\t\r\n]/.test(value) ? `'${value}` : value
  return `"${safe.replaceAll('"', '""')}"`
}

/** Keep only one page in memory and release the DB connection between pages. */
export async function* exportHistory(userId: string, format: HistoryExportFormat) {
  const size = 1000
  let cursor: Pick<ExportPlay, 'id' | 'cursorAt'> | undefined
  let first = true
  yield format === 'json' ? '[\n' : `${fields.join(',')}\r\n`
  for (;;) {
    const after = cursor ? sql`and (p.started_at, p.id) < (${cursor.cursorAt}::timestamptz, ${cursor.id}::uuid)` : sql``
    const rows = await db.execute<ExportPlay>(sql`
      with batch as (
        (select p.id, p.started_at, p.recording_id, p.album_id, p.ms_played, p.completed, p.skipped, p.client,
          p.context_type, p.context_id, null::text as title, null::text as artist, null::text as album
        from plays p where p.user_id = ${userId} ${after}
        order by p.started_at desc, p.id desc limit ${size})
        union all
        (select p.id, p.started_at, null, null, p.ms_played, null, p.skipped, p.source,
          null, null, p.title, p.artist, p.album
        from history_imported_plays p where p.user_id = ${userId} and p.play_id is null ${after}
        order by p.started_at desc, p.id desc limit ${size})
        order by started_at desc, id desc limit ${size}
      )
      select b.id, b.started_at::text as "cursorAt", ${isoTime('b.started_at')} as "startedAt",
        coalesce(i.title, b.title, r.title) as title, coalesce(i.artist, b.artist, r.artist_credit) as artist,
        coalesce(i.album, b.album, a.title) as album, b.recording_id as "recordingId",
        b.album_id as "albumId", b.ms_played as "msPlayed", b.completed, b.skipped,
        coalesce(i.source, b.client) as source, b.context_type as "contextType", b.context_id as "contextId"
      from batch b
      left join recordings r on r.id = b.recording_id
      left join albums a on a.id = b.album_id
      left join history_imported_plays i on i.play_id = b.id
      order by b.started_at desc, b.id desc`)
    for (const { cursorAt: _, ...row } of rows) {
      yield format === 'json' ? `${first ? '' : ',\n'}${JSON.stringify(row)}` : `${fields.map(field => csv(row[field])).join(',')}\r\n`
      first = false
    }
    if (rows.length < size) break
    cursor = rows[rows.length - 1]!
  }
  if (format === 'json') yield '\n]\n'
}
