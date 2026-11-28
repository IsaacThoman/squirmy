import path from 'node:path'
import { queryKeys, type DuplicateGroup, type DuplicatePage, type QualityPage, type RemoveDuplicate } from '@squirmy/contracts'
import { and, eq, gt, inArray, lt, sql } from 'drizzle-orm'
import { db, type Transaction } from '../../database/client.js'
import { albums, libraryRoots, mediaFiles, recordings } from '../../database/schema.js'
import { conflict } from '../../lib/errors.js'
import { invalidate } from '../../realtime/index.js'
import { deleteLibraryFile } from './delete.js'
import { collectionFile, describeFile, fileJoins, hygieneColumns, revision, unchangedFile, type FileRow } from './hygiene-files.js'

const limit = 25
const durationTolerance = 2000
const normalizedTitle = sql`lower(btrim(coalesce(nullif(tags->>'title', ''), recordings.title)))`
const normalizedArtist = sql`lower(btrim(coalesce(nullif(tags->>'artist', ''), recordings.artist_credit)))`
const mbid = sql`lower(coalesce(recordings.mbid::text, tags->>'mbRecordingId'))`

/** Each tag match spans at most two seconds. Adjacent overlapping matches remain distinct. */
const recordingGroups = sql`
  select 'recording:' || mbid as key, 'recording' as reason, id from files where mbid is not null
  union all
  select 'audio:' || audio_hash, 'audio', id from files where audio_hash is not null
  union all
  select 'tags:' || md5(json_build_array(f.artist, f.title, a.duration_ms)::text), 'tags', f.id
  from files f
  join (
    select *, lag(last) over (partition by artist, title order by duration_ms) as previous_last
    from (
      select *, max(duration_ms) over (partition by artist, title order by duration_ms
        range between current row and ${durationTolerance} following) as last
      from (select distinct artist, title, duration_ms from files where artist <> '' and title <> '' and duration_ms > 0) durations
    ) ranges
  ) a on a.artist = f.artist and a.title = f.title and f.duration_ms between a.duration_ms and a.last
  where a.previous_last is null or a.last > a.previous_last
`
// Compare physical copies, distinguished by root and scan group. Album titles/artist identify
// a likely match across local editions; the UI leaves individual removal to the recording view.
const albumGroups = sql`
  select 'album:' || md5(album_key), 'album', id
  from files
  where album_key in (select album_key from files where group_key is not null
    group by album_key having count(distinct (root_id, group_key)) > 1)
`

function displayOrder(a: FileRow, b: FileRow) {
  return Number(b.file.lossless) - Number(a.file.lossless) ||
    (b.file.bitDepth ?? 0) - (a.file.bitDepth ?? 0) ||
    (b.file.bitrate ?? 0) - (a.file.bitrate ?? 0) ||
    a.file.relPath.localeCompare(b.file.relPath) || a.file.id.localeCompare(b.file.id)
}

export async function listDuplicates(kind: 'recordings' | 'albums', cursor = ''): Promise<DuplicatePage> {
  const groups = await db.execute<{ key: string; reason: DuplicateGroup['reason']; ids: string[] }>(sql`
    with files as materialized (
      select media_files.id, root_id, group_key, audio_hash, media_files.duration_ms,
        ${mbid} as mbid, ${normalizedTitle} as title, ${normalizedArtist} as artist, albums.match_key as album_key
      from media_files
      left join recordings on recordings.id = media_files.recording_id
      left join albums on albums.id = media_files.album_id
      where ${collectionFile} and probe_stage >= 1
    ), groups(key, reason, id) as (${kind === 'albums' ? albumGroups : recordingGroups})
    select key, reason, array_agg(id) as ids from groups
    where key > ${cursor} group by key, reason having count(*) > 1 order by key limit ${limit + 1}
  `)
  const page = groups.slice(0, limit)
  if (!page.length) return { items: [], nextCursor: null }
  const rows = await db.select(hygieneColumns).from(mediaFiles)
    .innerJoin(libraryRoots, fileJoins.root).leftJoin(albums, fileJoins.album).leftJoin(recordings, fileJoins.recording)
    .where(and(collectionFile, inArray(mediaFiles.id, [...new Set(page.flatMap(group => group.ids))])))
  const byId = new Map(rows.map(row => [row.file.id, row]))
  const items = page.flatMap(group => {
    const files = group.ids.flatMap(id => byId.get(id) ?? []).sort(group.reason === 'album'
      ? (a, b) => path.join(a.root.path, a.file.relPath).localeCompare(path.join(b.root.path, b.file.relPath))
      : displayOrder).map(describeFile)
    if (files.length < 2) return []
    const first = files[0]!
    return [{ id: group.key, reason: group.reason, label: group.reason === 'album' ? first.album ?? first.title : first.title,
      files, bestId: group.reason === 'album' ? null : first.id }]
  })
  return { items, nextCursor: groups.length > limit ? page.at(-1)!.key : null }
}

export async function listLowQuality(cursor?: string): Promise<QualityPage> {
  const rows = await db.select(hygieneColumns).from(mediaFiles)
    .innerJoin(libraryRoots, fileJoins.root).leftJoin(albums, fileJoins.album).leftJoin(recordings, fileJoins.recording)
    .where(and(collectionFile, eq(mediaFiles.lossless, false), lt(mediaFiles.bitrate, 192000),
      gt(mediaFiles.bitrate, 0), cursor ? gt(mediaFiles.id, cursor) : undefined))
    .orderBy(mediaFiles.id).limit(limit + 1)
  return { items: rows.slice(0, limit).map(describeFile), nextCursor: rows.length > limit ? rows[limit - 1]!.file.id : null }
}

async function loadPair(tx: Transaction, fileId: string, keepId: string) {
  return tx.select({
    file: mediaFiles, root: libraryRoots, mbid,
    title: normalizedTitle, artist: normalizedArtist,
  }).from(mediaFiles).innerJoin(libraryRoots, fileJoins.root).leftJoin(recordings, fileJoins.recording)
    .where(and(collectionFile, inArray(mediaFiles.id, [fileId, keepId])))
    .for('update', { of: [mediaFiles, libraryRoots] })
}

export async function removeDuplicate(fileId: string, request: RemoveDuplicate) {
  const removed = await deleteLibraryFile(fileId, {
    where: and(collectionFile, eq(libraryRoots.enabled, true)), tidy: false,
    async beforeUnlink(tx) {
      const pair = await loadPair(tx, fileId, request.keepId)
      const file = pair.find(row => row.file.id === fileId)
      const keep = pair.find(row => row.file.id === request.keepId)
      if (!file || !keep || keep === file || revision(file.file) !== request.revision) {
        throw conflict('The copies have changed. Refresh the list and choose again.', 'duplicate_changed')
      }
      const duplicate = request.reason === 'audio' ? file.file.audioHash && file.file.audioHash === keep.file.audioHash
        : request.reason === 'recording' ? file.mbid && file.mbid === keep.mbid
          : file.title && file.artist && file.title === keep.title && file.artist === keep.artist &&
            Math.min(file.file.durationMs, keep.file.durationMs) > 0 && Math.abs(file.file.durationMs - keep.file.durationMs) <= durationTolerance
      if (!duplicate) throw conflict('The files no longer match as duplicates', 'duplicate_changed')
      await unchangedFile(file.root, file.file)
      await unchangedFile(keep.root, keep.file)
    },
  })
  if (!removed) throw conflict('Only present copies in enabled managed folders can be deleted', 'duplicate_changed')
  await invalidate('all', [queryKeys.library(), queryKeys.home(), ...(removed.albumId ? [queryKeys.album(removed.albumId)] : [])])
}
