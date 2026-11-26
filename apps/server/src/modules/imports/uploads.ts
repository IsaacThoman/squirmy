/**
 * Uploads as their uploaders and admins manage them (`GET /me/uploads`, `GET
 * /admin/uploads` and their deletes; docs/architecture.md, "Imports").
 *
 * An upload is a present file of a finished `upload` or `inbox` import (`media_files.import_id`),
 * grouped by the import's user (none for the inbox) and the file's album. Imports still
 * running are left out: their files are still being identified and filed. Deleting goes
 * through `deleteLibraryFile` (library/delete.ts), the provider cache's deleter: from disk,
 * the row, the local-only catalog rows it leaves unused, sidecars and empty folders. Only
 * the files of the uploads named are touched: a scanned file of the same song, or someone
 * else's upload of it, stays.
 */
import path from 'node:path'
import {
  queryKeys,
  type DeleteUploadsResponse, type PageQuery, type UploadAlbum, type UploadAlbumPage, type Uploader, type UploaderFilter, type UploadFile,
} from '@squirmy/contracts'
import { sql, type SQL } from 'drizzle-orm'
import { db, type Transaction } from '../../database/client.js'
import { mediaFiles } from '../../database/schema.js'
import { conflict, notFound } from '../../lib/errors.js'
import { invalidate, publishChanges } from '../../realtime/index.js'
import { announceAvailability } from '../acquisition/resolve.js'
import { after, cursorKeys, orderBy, toPage, type Ordering } from '../catalog/pagination.js'
import { resolveMerged } from '../catalog/redirects.js'
import { isoTime, uuidArray } from '../catalog/sql.js'
import { albumSummaries, alignedTrackSummaries } from '../catalog/summaries.js'
import { deleteLibraryFile, type DeletedFile } from '../library/delete.js'
import { recordCollectionAdd } from '../sessions/collection-plays.js'
import { announceUserChange } from '../userdata/changes.js'

/**
 * Whose uploads: one user's own (`/me/uploads`), or for an admin one uploader's, the
 * inbox's (`inbox`, imports with no user), or everyone's (no `uploader`).
 */
export type UploadScope = { own: string } | { uploader?: UploaderFilter }

/** Condition on the import alias `i`: its files are uploads in the scope, and it has finished. */
function inScope(scope: UploadScope): SQL {
  const finished = sql`i.kind in ('upload', 'inbox') and i.status in ('completed', 'failed')`
  if ('own' in scope) return sql`${finished} and i.kind = 'upload' and i.user_id = ${scope.own}`
  if (scope.uploader === 'inbox') return sql`${finished} and i.user_id is null`
  if (scope.uploader) return sql`${finished} and i.user_id = ${scope.uploader}`
  return finished
}

const noUploader = '00000000-0000-0000-0000-000000000000'

const uploadOrdering: Ordering = {
  name: 'uploads:recent',
  keys: [
    { expression: sql.raw('g.at'), type: 'timestamptz', descending: true },
    { expression: sql.raw('g.album_id'), type: 'uuid', descending: true },
    { expression: sql.raw(`coalesce(g.uploader_id, '${noUploader}'::uuid)`), type: 'uuid', descending: true },
  ],
}

async function uploaders(ids: readonly (string | null)[]): Promise<Map<string, Uploader>> {
  const known = [...new Set(ids.filter((id): id is string => id !== null))]
  if (known.length === 0) return new Map()
  const rows = await db.execute<Uploader>(sql`
    select id, username, display_name as "displayName" from users where id = any(${uuidArray(known)})`)
  return new Map(rows.map((row) => [row.id, row]))
}

/** One page of the uploads in the scope, by album and uploader, the newest upload first. */
export async function listUploads(scope: UploadScope, query: PageQuery): Promise<UploadAlbumPage> {
  const rows = await db.execute<{
    uploaderId: string | null; albumId: string; files: number; bytes: string; at: string; cursorKeys: string[]
  }>(sql`
    select g.uploader_id as "uploaderId", g.album_id as "albumId", g.files, g.bytes, ${isoTime('g.at')} as at, ${cursorKeys(uploadOrdering)}
    from (
      select i.user_id as uploader_id, f.album_id, count(*)::int as files, sum(f.size)::bigint as bytes, max(f.added_at) as at
      from imports i join media_files f on f.import_id = i.id
      where ${inScope(scope)} and f.missing_since is null and f.album_id is not null
      group by i.user_id, f.album_id
    ) g
    where ${after(uploadOrdering, query.cursor)}
    order by ${orderBy(uploadOrdering)} limit ${query.limit + 1}`)
  const shown = rows.slice(0, query.limit)
  const [albums, people] = await Promise.all([
    albumSummaries(shown.map((row) => row.albumId)),
    uploaders(shown.map((row) => row.uploaderId)),
  ])
  const byId = new Map(albums.map((album) => [album.id, album]))
  const items = shown.flatMap((row): UploadAlbum[] => {
    const album = byId.get(row.albumId)
    if (!album) return []
    return [{
      album,
      uploader: row.uploaderId ? people.get(row.uploaderId) ?? null : null,
      fileCount: row.files,
      bytes: Number(row.bytes),
      uploadedAt: row.at,
    }]
  })
  return toPage(uploadOrdering, rows, query.limit, items)
}

type FileRow = {
  id: string; recordingId: string | null; albumId: string; uploaderId: string | null; codec: string; size: number
  durationMs: number; addedAt: string; title: string | null; relPath: string; managed: boolean
}

async function albumFiles(scope: UploadScope, albumId: string): Promise<FileRow[]> {
  const resolved = (await resolveMerged('albums', [albumId])).get(albumId) ?? albumId
  return db.execute<FileRow>(sql`
    select f.id, f.recording_id as "recordingId", f.album_id as "albumId", i.user_id as "uploaderId", f.codec, f.size::int8 as size,
      f.duration_ms as "durationMs", ${isoTime('f.added_at')} as "addedAt", f.tags->>'title' as title, f.rel_path as "relPath",
      (r.mode = 'managed') as managed
    from media_files f join imports i on i.id = f.import_id join library_roots r on r.id = f.root_id
    left join release_tracks rt on rt.id = f.release_track_id
    where f.album_id = ${resolved} and f.missing_since is null and ${inScope(scope)}
    order by rt.disc nulls last, rt.position nulls last, f.rel_path, f.id`)
}

/** The uploaded files in the scope on one album, in track order. */
export async function listUploadFiles(viewerId: string, scope: UploadScope, albumId: string): Promise<UploadFile[]> {
  const files = await albumFiles(scope, albumId)
  const linked = files.filter((file) => file.recordingId !== null)
  const [summaries, people] = await Promise.all([
    alignedTrackSummaries(viewerId, linked.map((file) => ({ id: file.recordingId!, albumId: file.albumId }))),
    uploaders(files.map((file) => file.uploaderId)),
  ])
  const tracks = new Map(linked.map((file, index) => [file.id, summaries[index] ?? null]))
  return files.map((file) => ({
    fileId: file.id,
    track: tracks.get(file.id) ?? null,
    title: file.title ?? path.posix.basename(file.relPath).replace(/\.[^.]+$/, ''),
    uploader: file.uploaderId ? people.get(file.uploaderId) ?? null : null,
    codec: file.codec,
    bytes: Number(file.size),
    durationMs: file.durationMs,
    uploadedAt: file.addedAt,
  }))
}

/**
 * In the deleting transaction: once the album holds no file, the uploader's own save of it
 * goes, since finishing the upload made it (`saveUploadedAlbums`). Other people's saves stay.
 */
async function dropUploaderSave(tx: Transaction, file: DeletedFile, dropped: Map<string, Set<string>>) {
  if (!file.albumId || !file.importId) return
  const [row] = await tx.execute<{ userId: string | null }>(sql`
    delete from likes l using imports i
    where i.id = ${file.importId} and i.kind = 'upload' and l.user_id = i.user_id
      and l.entity_type = 'album' and l.entity_id = ${file.albumId}
      and not exists (select 1 from media_files f where f.album_id = ${file.albumId})
    returning l.user_id as "userId"`)
  if (row?.userId) dropped.set(row.userId, (dropped.get(row.userId) ?? new Set()).add(file.albumId))
}

/** Deletes the files, telling every client what changed. Returns what went and what stayed. */
async function deleteFiles(files: readonly FileRow[], scope: UploadScope): Promise<DeleteUploadsResponse> {
  const result: DeleteUploadsResponse = { deletedFiles: 0, deletedBytes: 0, keptFiles: 0 }
  const recordings = new Set<string>()
  const albums = new Set<string>()
  const owners = new Set<string>()
  const dropped = new Map<string, Set<string>>()
  for (const file of files) {
    if (!file.managed) {
      result.keptFiles += 1
      continue
    }
    const gone = await deleteLibraryFile(file.id, {
      // The file must still be an upload in the scope when its row is locked.
      where: sql`exists (select 1 from imports i where i.id = ${mediaFiles.importId} and ${inScope(scope)})`,
      beforeOrphans: (tx, deleted) => dropUploaderSave(tx, deleted, dropped),
      tidy: 'anywhere',
    }).catch((error: unknown) => {
      console.error('[imports]', error)
      return null
    })
    if (!gone) {
      result.keptFiles += 1
      continue
    }
    result.deletedFiles += 1
    result.deletedBytes += gone.size
    if (gone.recordingId) recordings.add(gone.recordingId)
    if (gone.albumId) albums.add(gone.albumId)
    if (file.uploaderId) owners.add(file.uploaderId)
  }
  if (result.deletedFiles > 0) await announceDeleted([...recordings], [...albums], [...owners], dropped)
  return result
}

/**
 * Collection files went: every library that includes the collection, the server's lists and
 * Home move for everyone, the songs turn gray or on demand where they show, and an album
 * left with no row is announced as gone.
 */
async function announceDeleted(recordingIds: string[], albumIds: string[], owners: string[], dropped: Map<string, Set<string>>) {
  await announceAvailability(recordingIds)
  const remaining = await db.execute<{ id: string }>(sql`select id from albums where id = any(${uuidArray(albumIds)})`)
  const kept = new Set(remaining.map((row) => row.id))
  const gone = albumIds.filter((id) => !kept.has(id))
  if (gone.length > 0) await publishChanges('all', [{ kind: 'deleted', entity: 'album', ids: gone }])
  await invalidate('all', [queryKeys.library(), queryKeys.home(), ...[...kept].map((id) => queryKeys.album(id))])
  for (const [user, saves] of dropped) {
    for (const album of saves) if (kept.has(album)) await announceUserChange(user, 'album', album)
    await invalidate({ user }, [queryKeys.likes()])
  }
  for (const user of owners) await invalidate({ user }, [queryKeys.uploads()])
  await invalidate('admins', [queryKeys.admin()])
}

/** Deletes every uploaded file in the scope on the album. 404 `upload_not_found` when there is none. */
export async function deleteUploadAlbum(scope: UploadScope, albumId: string): Promise<DeleteUploadsResponse> {
  const files = await albumFiles(scope, albumId)
  if (files.length === 0) throw notFound('No such upload', 'upload_not_found')
  return deleteFiles(files, scope)
}

/**
 * Deletes one uploaded file in the scope. 404 `upload_not_found` when it is not one;
 * 409 `upload_not_deletable` when it is outside a managed root.
 */
export async function deleteUploadFile(scope: UploadScope, fileId: string): Promise<DeleteUploadsResponse> {
  const [file] = await db.execute<FileRow>(sql`
    select f.id, f.recording_id as "recordingId", f.album_id as "albumId", i.user_id as "uploaderId", f.codec, f.size::int8 as size,
      f.duration_ms as "durationMs", ${isoTime('f.added_at')} as "addedAt", f.tags->>'title' as title, f.rel_path as "relPath",
      (r.mode = 'managed') as managed
    from media_files f join imports i on i.id = f.import_id join library_roots r on r.id = f.root_id
    where f.id = ${fileId} and f.missing_since is null and ${inScope(scope)}`)
  if (!file) throw notFound('No such upload', 'upload_not_found')
  if (!file.managed) throw conflict('The file is in a read-only library folder, which Squirmy never deletes from', 'upload_not_deletable')
  const result = await deleteFiles([file], scope)
  if (result.deletedFiles === 0) throw notFound('No such upload', 'upload_not_found')
  return result
}

/**
 * When an upload import finishes: saves (hearts) its albums for the uploader, so their own
 * uploads are in their library whether or not it includes the server's music. Inbox imports
 * have no user. An existing save keeps its time. Nothing is fetched: the upload is the music.
 * A newly saved album heads the uploader's Recently played, as a heart would.
 */
export async function saveUploadedAlbums(importId: string): Promise<void> {
  const saved = await db.execute<{ userId: string; albumId: string }>(sql`
    insert into likes (user_id, entity_type, entity_id, created_at)
    select distinct i.user_id, 'album', f.album_id, now()
    from imports i join media_files f on f.import_id = i.id
    where i.id = ${importId} and i.kind = 'upload' and i.user_id is not null
      and f.album_id is not null and f.missing_since is null
    on conflict do nothing
    returning user_id as "userId", entity_id as "albumId"`)
  for (const row of saved) {
    await recordCollectionAdd(row.userId, { type: 'album', id: row.albumId })
    await announceUserChange(row.userId, 'album', row.albumId)
  }
}
