import { readdir, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { editableCreditRoles, queryKeys, type TagEdit, type TagEditResult, type TagEditor } from '@squirmy/contracts'
import { and, asc, eq, inArray, isNull, or, sql } from 'drizzle-orm'
import sharp from 'sharp'
import { db, type Executor, type Transaction } from '../../database/client.js'
import { trySessionLock, type SessionLock } from '../../database/locks.js'
import { albums, assets, libraryRoots, mediaFiles, releases, type FileTags } from '../../database/schema.js'
import { AppError, badRequest, conflict, notFound } from '../../lib/errors.js'
import { newId } from '../../lib/ids.js'
import { invalidate } from '../../realtime/index.js'
import { readOriginal, remoteImage, storeImage } from '../artwork/index.js'
import { lockCatalog } from '../library/cleanup.js'
import { albumFolder } from '../library/grouping.js'
import { collectionFile, revision, unchangedFile, type FileRow } from '../library/hygiene-files.js'
import { probeTagEdit } from '../library/probe.js'
import { coverart, deezer } from '../metadata/index.js'
import { externalIdOf } from '../enrichment/rows.js'
import { fsyncPath, removeIfExists } from './files.js'
import { TAG_WRITABLE, writeTagEdit } from './tags.js'

type Entry = Pick<FileRow, 'file' | 'root'>

function editorRows(albumId: string, executor: Executor = db) {
  return executor.select({ file: mediaFiles, root: libraryRoots }).from(mediaFiles)
    .innerJoin(libraryRoots, eq(mediaFiles.rootId, libraryRoots.id))
    .where(and(eq(mediaFiles.albumId, albumId), collectionFile))
    .orderBy(asc(libraryRoots.name), asc(mediaFiles.relPath))
}

function editReason({ file, root }: Entry): string | null {
  if (root.mode !== 'managed') return 'This file is in a read-only folder.'
  if (!root.enabled) return 'This library folder is disabled.'
  if (!TAG_WRITABLE.has(path.extname(file.relPath).slice(1).toLowerCase())) return 'This file format does not support verified tag editing.'
  return null
}

function editorTags(tags: FileTags): TagEditor['tracks'][number]['tags'] {
  const { album, albumArtist, date, year, genres, compilation, discTotal, title, artist, track, disc, credits } = tags
  return {
    album, albumArtist, date: date ?? (year ? String(year) : undefined), genres, compilation, discTotal,
    title, artist, track, disc,
    ...Object.fromEntries(editableCreditRoles.map(role => [role, credits?.filter(credit => credit.role === role).map(credit => credit.name) ?? []])),
  }
}

export async function loadTagEditor(albumId: string): Promise<TagEditor> {
  const [album] = await db.select({ cover: albums.artworkAssetId }).from(albums).where(eq(albums.id, albumId))
  if (!album) throw notFound('No such album')
  const files = await editorRows(albumId)
  const ids = [...new Set([album.cover, ...files.map(row => row.file.embeddedArtAssetId)].filter((id): id is string => !!id))]
  const covers = ids.length ? await db.select({ id: assets.id, width: assets.width, height: assets.height }).from(assets)
    .where(inArray(assets.id, ids)) : []
  return {
    tracks: files.map(row => ({
      id: row.file.id, path: path.join(row.root.path, row.file.relPath), revision: revision(row.file),
      group: row.file.groupKey ?? row.root.id, matchLocked: row.file.matchLocked, reason: editReason(row), tags: editorTags(row.file.tags),
    })),
    covers,
  }
}

export async function findTagEditorCovers(albumId: string): Promise<TagEditor['covers']> {
  const [album] = await db.select({ group: albums.mbid }).from(albums).where(eq(albums.id, albumId))
  if (!album) throw notFound('No such album')
  const editions = await db.selectDistinct({ mbid: releases.mbid }).from(mediaFiles)
    .innerJoin(releases, eq(mediaFiles.releaseId, releases.id))
    .where(and(eq(mediaFiles.albumId, albumId), collectionFile)).limit(5)
  const deezerId = await externalIdOf('deezer', 'album', albumId)
  const found = await Promise.allSettled([
    ...(album.group ? [coverart.getReleaseGroupCover(album.group)] : []),
    ...editions.flatMap(({ mbid }) => mbid ? [coverart.getReleaseCover(mbid)] : []),
    ...(deezerId ? [deezer.getAlbum(Number(deezerId)).then(album => album?.coverUrl)] : []),
  ])
  const urls = [...new Set(found.flatMap(result => result.status === 'fulfilled' && result.value ? [result.value] : []))]
  return Promise.all(urls.map(async url => {
    const { id, width, height } = await remoteImage(url, { kind: 'cover' })
    return { id, width, height }
  }))
}

async function coverBytes(image: NonNullable<TagEdit['cover']>['image']) {
  const bytes = 'base64' in image ? Buffer.from(image.base64, 'base64') : (await readOriginal(image.assetId)).bytes
  try {
    return await sharp(bytes, { limitInputPixels: 40_000_000 }).rotate()
      .resize(2400, 2400, { fit: 'inside', withoutEnlargement: true }).flatten().jpeg({ quality: 92 }).toBuffer()
  } catch {
    throw badRequest('Choose a readable cover image', 'invalid_image')
  }
}

async function writeFolderCover(tx: Transaction, albumId: string, row: Entry, bytes: Buffer) {
  const folder = albumFolder(row.file.relPath).dir
  if (folder === '.') throw conflict('Embed the cover for files directly in the library folder', 'shared_cover_folder')
  const [other] = await tx.select({ id: mediaFiles.id }).from(mediaFiles)
    .where(and(eq(mediaFiles.rootId, row.root.id), isNull(mediaFiles.missingSince),
      or(isNull(mediaFiles.albumId), sql`${mediaFiles.albumId} <> ${albumId}`),
      sql`starts_with(${mediaFiles.relPath}, ${folder + '/'})`)).limit(1)
  if (other) throw conflict('Embed the cover when several albums share a folder', 'shared_cover_folder')
  const dir = path.join(row.root.path, folder)
  const names = await readdir(dir)
  const existing = names.find(name => name.toLowerCase() === 'cover.jpg')
  const destination = path.join(dir, existing ?? 'cover.jpg')
  const temp = path.join(dir, `.squirmy-cover-${newId()}.jpg`)
  const asset = await storeImage(bytes, { kind: 'cover', source: `folder:${destination}` })
  try {
    await writeFile(temp, bytes, { flag: 'wx' })
    await fsyncPath(temp)
    await rename(temp, destination)
    await fsyncPath(dir)
  } finally {
    await removeIfExists(temp)
  }
  return asset.id
}

function reason(error: unknown) {
  return error instanceof AppError ? error.message : (error as Error).message.slice(0, 500)
}

export async function editAlbumTags(albumId: string, edit: TagEdit): Promise<TagEditResult> {
  const submitted = new Map(edit.tracks.map(track => [track.id, track]))
  const planned = (await editorRows(albumId)).filter(row => submitted.has(row.file.id))
  const priorRoots = new Map(planned.map(row => [row.file.id, row.root.id]))
  if (planned.length !== submitted.size) throw conflict('Album files have changed. Reopen the editor.', 'album_changed')
  const bytes = edit.cover ? await coverBytes(edit.cover.image) : undefined
  const embedded = edit.cover?.mode === 'folder' ? undefined : bytes
  const locks: SessionLock[] = []
  const result: TagEditResult = { written: [], errors: [] }
  try {
    for (const rootId of [...new Set(planned.map(row => row.root.id))].sort()) {
      const lock = await trySessionLock(`squirmy.organize:${rootId}`)
      if (!lock) throw conflict('Another operation is using a library folder. Try again shortly.', 'organize_busy')
      locks.push(lock)
    }
    await db.transaction(async tx => {
      await lockCatalog(tx)
      const rows = (await editorRows(albumId, tx).for('update', { of: [mediaFiles, libraryRoots] }))
        .filter(row => submitted.has(row.file.id))
      if (rows.length !== submitted.size) throw conflict('Album files have changed. Reopen the editor.', 'album_changed')
      const paths = new Map(rows.map(row => [row.file.id, path.join(row.root.path, row.file.relPath)]))
      const folders = new Map<string, Entry>()
      let coverId: string | undefined
      for (const row of rows) {
        const { file, root } = row
        const absolute = path.join(root.path, file.relPath)
        const change = submitted.get(file.id)!
        try {
          const unavailable = editReason(row)
          if (unavailable) throw badRequest(unavailable, 'file_not_editable')
          if (revision(file) !== change.revision || priorRoots.get(file.id) !== root.id) {
            throw conflict('The file has changed. Reopen the editor.', 'file_changed')
          }
          await unchangedFile(root, file)
          const patch = { ...edit.album, ...change.tags }
          if (Object.keys(patch).length || embedded) {
            const written = await writeTagEdit(absolute, patch, embedded, {
              temp: path.join(path.dirname(absolute), `.squirmy-tags-${newId()}${path.extname(absolute)}`),
              expectedAudioHash: file.audioHash,
            })
            if (!written.written) throw badRequest(written.reason, 'tag_write_failed')
            result.written.push(file.id)
          }
          if (embedded) coverId ??= (await storeImage(embedded, { kind: 'cover', source: `file:${file.id}` })).id
          if (bytes && edit.cover?.mode !== 'embedded') folders.set(path.join(root.path, albumFolder(file.relPath).dir), row)
        } catch (error) {
          result.errors.push({ path: absolute, reason: reason(error) })
        }
      }
      for (const [folder, row] of folders) {
        try {
          const id = await writeFolderCover(tx, albumId, row, bytes!)
          coverId ??= id
          if (!result.written.includes(row.file.id)) result.written.push(row.file.id)
        } catch (error) {
          result.errors.push({ path: folder, reason: reason(error) })
        }
      }
      if (coverId) await tx.update(albums).set({ artworkAssetId: coverId, artworkLocked: true, updatedAt: new Date() }).where(eq(albums.id, albumId))
      for (const id of result.written) {
        const change = submitted.get(id)!
        const error = await probeTagEdit({ fileId: id }, tx, Object.keys(edit.album).length > 0 || Object.keys(change.tags).length > 0)
        if (error) result.errors.push({ path: paths.get(id)!, reason: error })
      }
    })
  } finally {
    for (const lock of locks.reverse()) await lock.release()
  }
  if (result.written.length) await invalidate('all', [queryKeys.album(albumId), queryKeys.library(), queryKeys.home()])
  return result
}
