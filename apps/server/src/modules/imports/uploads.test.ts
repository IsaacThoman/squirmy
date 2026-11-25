import { mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { AlbumPage, DeleteUploadsResponse, UploadAlbumPage, UploadFileList } from '@squirmy/contracts'
import { eq, inArray } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from '../../app.js'
import { db } from '../../database/client.js'
import { albums, imports, likes, mediaFiles } from '../../database/schema.js'
import { newId } from '../../lib/ids.js'
import { body, errorCode, signIn } from '../../test/api.js'
import { createFile } from '../../test/catalog.js'
import { useTestDatabase } from '../../test/database.js'
import { createAlbum, createLibraryRoot } from '../../test/factories.js'
import { saveUploadedAlbums } from './uploads.js'

type User = Awaited<ReturnType<typeof signIn>>

const exists = (file: string) => readdir(path.dirname(file)).then((names) => names.includes(path.basename(file)), () => false)

/**
 * Uploads as their uploaders and admins manage them: listed by album, joined to the
 * uploader's library, and deleted from disk and the catalog for everyone.
 */
describe('uploads', () => {
  useTestDatabase()
  let app: FastifyInstance
  let root: { id: string; path: string }
  let ana: User
  let ben: User
  let admin: User

  const get = (user: User, url: string) => app.inject({ url: `/api/v1${url}`, headers: user.headers })
  const remove = (user: User, url: string) => app.inject({ method: 'DELETE', url: `/api/v1${url}`, headers: user.headers })
  const albumIds = async (user: User, url = '/library/albums') => body(await get(user, `${url}?limit=200`), AlbumPage).items.map((album) => album.id)

  /** An album whose files arrived through a finished import of `kind`, written to disk with a cover beside them. */
  async function uploaded(title: string, kind: 'upload' | 'inbox', userId: string | null, status: 'completed' | 'processing' = 'completed') {
    const album = await createAlbum({ title, owned: true, rootId: root.id, source: kind })
    const importId = newId()
    await db.insert(imports).values({ id: importId, kind, source: kind, userId, status, stagingPath: path.join(root.path, '.staging', importId) })
    const files = await db.update(mediaFiles).set({ importId }).where(eq(mediaFiles.albumId, album.albumId)).returning()
    for (const file of files) {
      const absolute = path.join(root.path, file.relPath)
      await mkdir(path.dirname(absolute), { recursive: true })
      await writeFile(absolute, 'not really audio')
      await writeFile(path.join(path.dirname(absolute), 'cover.jpg'), 'jpeg')
    }
    if (status === 'completed') await saveUploadedAlbums(importId)
    return { ...album, importId, files }
  }

  beforeAll(async () => {
    app = await buildApp()
    const folder = await mkdtemp(path.join(tmpdir(), 'squirmy-uploads-'))
    root = await createLibraryRoot({ name: 'Managed', path: folder, mode: 'managed' })
    ana = await signIn({ canUpload: true })
    ben = await signIn({ canUpload: true })
    admin = await signIn({ role: 'admin' })
  })
  afterAll(async () => {
    await app.close()
  })

  it("puts an upload in its uploader's library, and on the server for everyone", async () => {
    const tones = await uploaded('Tones', 'upload', ana.id)
    expect(await albumIds(ana)).toEqual([tones.albumId])
    expect(await albumIds(ben)).toEqual([])
    expect(await albumIds(ben, '/collection/albums')).toEqual([tones.albumId])

    const mine = body(await get(ana, '/me/uploads'), UploadAlbumPage)
    expect(mine.items).toHaveLength(1)
    expect(mine.items[0]).toMatchObject({ album: { id: tones.albumId, title: 'Tones' }, uploader: { id: ana.id }, fileCount: 3, bytes: 3_000_000 })
    expect(body(await get(ben, '/me/uploads'), UploadAlbumPage).items).toEqual([])
    const songs = body(await get(ana, `/me/uploads/albums/${tones.albumId}`), UploadFileList).items
    expect(songs.map((song) => song.track?.title)).toEqual(['Track One', 'Track Two', 'Track Three'])
    expect(songs.every((song) => song.codec === 'flac' && song.track?.inLibrary)).toBe(true)
    expect(body(await get(ben, `/me/uploads/albums/${tones.albumId}`), UploadFileList).items).toEqual([])

    // An admin sees everyone's, and one uploader's.
    expect(errorCode(await get(ana, '/admin/uploads'), 403)).toBe('forbidden')
    const all = body(await get(admin, '/admin/uploads'), UploadAlbumPage)
    expect(all.items.map((item) => [item.album.id, item.uploader?.id])).toEqual([[tones.albumId, ana.id]])
    expect(body(await get(admin, `/admin/uploads?uploader=${ben.id}`), UploadAlbumPage).items).toEqual([])
    expect(body(await get(admin, '/admin/uploads?uploader=inbox'), UploadAlbumPage).items).toEqual([])
  })

  it("deletes a song, then the album, from disk and everyone's views, keeping a scanned copy", async () => {
    const album = await uploaded('Deleted Here', 'upload', ana.id)
    // A scanned file of the first song is not an upload: it stays.
    const scanned = await createFile({ rootId: root.id, recordingId: album.tracks[0]!.recordingId, albumId: album.albumId, relPath: 'scanned/one.flac' })
    const [first, second, third] = album.files.sort((a, b) => a.relPath.localeCompare(b.relPath))

    expect(errorCode(await remove(ben, `/me/uploads/files/${first!.id}`), 404)).toBe('upload_not_found')
    expect(errorCode(await remove(ana, `/me/uploads/files/${scanned}`), 404)).toBe('upload_not_found')
    expect(body(await remove(ana, `/me/uploads/files/${second!.id}`), DeleteUploadsResponse)).toEqual({ deletedFiles: 1, deletedBytes: 1_000_000, keptFiles: 0 })
    expect(await exists(path.join(root.path, second!.relPath))).toBe(false)
    expect(body(await get(ana, `/me/uploads/albums/${album.albumId}`), UploadFileList).items).toHaveLength(2)

    expect(body(await remove(ana, `/me/uploads/albums/${album.albumId}`), DeleteUploadsResponse)).toMatchObject({ deletedFiles: 2, keptFiles: 0 })
    for (const file of [first, third]) expect(await exists(path.join(root.path, file!.relPath))).toBe(false)
    expect(errorCode(await remove(ana, `/me/uploads/albums/${album.albumId}`), 404)).toBe('upload_not_found')
    const left = await db.select({ id: mediaFiles.id }).from(mediaFiles).where(eq(mediaFiles.albumId, album.albumId))
    expect(left.map((row) => row.id)).toEqual([scanned])
    // The album still has a file, so Ana's save of it stays and so does the album.
    expect(await albumIds(ana)).toContain(album.albumId)
    expect(body(await get(ana, '/me/uploads'), UploadAlbumPage).items.map((item) => item.album.id)).not.toContain(album.albumId)
  })

  it("lets an admin delete anyone's upload and the inbox's, taking the album, its folder and the uploader's save", async () => {
    const theirs = await uploaded('Bens Album', 'upload', ben.id)
    const inbox = await uploaded('From The Inbox', 'inbox', null)
    expect(await albumIds(ben)).toContain(theirs.albumId)
    const listed = body(await get(admin, '/admin/uploads?uploader=inbox'), UploadAlbumPage).items
    expect(listed.map((item) => [item.album.id, item.uploader])).toEqual([[inbox.albumId, null]])

    expect(errorCode(await remove(ana, `/me/uploads/albums/${theirs.albumId}`), 404)).toBe('upload_not_found')
    expect(body(await remove(admin, `/admin/uploads/albums/${theirs.albumId}?uploader=${ben.id}`), DeleteUploadsResponse).deletedFiles).toBe(3)
    expect(await db.select().from(albums).where(eq(albums.id, theirs.albumId))).toEqual([])
    expect(await db.select().from(likes).where(eq(likes.entityId, theirs.albumId))).toEqual([])
    expect(await albumIds(ben)).not.toContain(theirs.albumId)
    expect(await albumIds(ana, '/collection/albums')).not.toContain(theirs.albumId)
    // The folder held only the songs and their cover, so it went, and its artist's empty folder too.
    const folder = path.join(root.path, path.dirname(theirs.files[0]!.relPath))
    expect(await exists(folder)).toBe(false)
    expect(await exists(path.dirname(folder))).toBe(false)

    const [one] = inbox.files
    expect(body(await remove(admin, `/admin/uploads/files/${one!.id}`), DeleteUploadsResponse).deletedFiles).toBe(1)
    expect(body(await remove(admin, `/admin/uploads/albums/${inbox.albumId}?uploader=inbox`), DeleteUploadsResponse).deletedFiles).toBe(2)
    expect(body(await get(admin, '/admin/uploads?uploader=inbox'), UploadAlbumPage).items).toEqual([])
  })

  it('never deletes outside a managed root, and leaves running imports alone', async () => {
    const running = await uploaded('Still Running', 'upload', ana.id, 'processing')
    expect(body(await get(ana, '/me/uploads'), UploadAlbumPage).items.map((item) => item.album.id)).not.toContain(running.albumId)
    expect(errorCode(await remove(ana, `/me/uploads/files/${running.files[0]!.id}`), 404)).toBe('upload_not_found')

    const kept = await uploaded('Read Only Now', 'upload', ana.id)
    const readOnly = await createLibraryRoot({ name: 'Read only', path: `${root.path}-read-only`, mode: 'read_only' })
    await db.update(mediaFiles).set({ rootId: readOnly.id }).where(inArray(mediaFiles.id, kept.files.map((file) => file.id)))
    expect(errorCode(await remove(ana, `/me/uploads/files/${kept.files[0]!.id}`), 409)).toBe('upload_not_deletable')
    expect(body(await remove(ana, `/me/uploads/albums/${kept.albumId}`), DeleteUploadsResponse)).toEqual({ deletedFiles: 0, deletedBytes: 0, keptFiles: 3 })
    expect(await exists(path.join(root.path, kept.files[0]!.relPath))).toBe(true)
  })
})
