import { copyFile, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DuplicatePage, HealthPage, QualityPage, TagEditResult, TagEditor } from '@squirmy/contracts'
import { asc, eq } from 'drizzle-orm'
import type { FastifyInstance, InjectOptions } from 'fastify'
import { parseFile } from 'music-metadata'
import { afterAll, beforeAll, describe, expect, it, onTestFinished } from 'vitest'
import { buildApp } from '../../app.js'
import { db } from '../../database/client.js'
import { albums, mediaFiles } from '../../database/schema.js'
import { drainJobs, jobs, startJobs, stopJobs } from '../../jobs/index.js'
import { audioHash } from '../../lib/ffmpeg.js'
import { updateServerSettings } from '../../lib/settings.js'
import { makeAlbum, makeTone } from '../../test/audio.js'
import { useTestDatabase } from '../../test/database.js'
import { libraryModule } from './index.js'
import { inspectAudio, scrubFiles } from './health.js'
import { stopProgress } from './progress.js'
import { insertRoot } from './roots.js'
import { scanRoot } from './scan.js'

async function root(mode: 'managed' | 'read_only' = 'managed') {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), 'squirmy-hygiene-test-')))
  onTestFinished(() => rm(dir, { recursive: true, force: true }))
  return insertRoot({ path: dir, name: path.basename(dir), mode, watch: false })
}

async function scan(rootId: string) {
  await scanRoot({ rootId })
  await drainJobs()
  return db.select().from(mediaFiles).where(eq(mediaFiles.rootId, rootId)).orderBy(asc(mediaFiles.relPath))
}

describe('library hygiene', () => {
  useTestDatabase()
  let app: FastifyInstance
  let admin: { authorization: string }
  const call = (url: string, options: Omit<InjectOptions, 'url'> = {}) =>
    app.inject({ ...options, url: '/api/v1/admin/' + url, headers: admin })

  beforeAll(async () => {
    await libraryModule.jobs!(jobs)
    await startJobs({ work: true })
    await updateServerSettings({ fileHealthIntervalDays: 0 })
    app = await buildApp()
    const setup = await app.inject({ method: 'POST', url: '/api/v1/setup', payload: { username: 'root', password: 'root password' } })
    admin = { authorization: `Bearer ${setup.json().token}` }
  })
  afterAll(async () => {
    await stopProgress()
    await app.close()
    await stopJobs()
  })

  it('writes only submitted tags and cover art, keeps the audio and regroups playable files', async () => {
    const folder = await root()
    const paths = await makeAlbum(folder.path, {
      artist: 'Mira Vale', album: 'Original', year: 2022, cover: true, tracks: [
        { title: 'blue morning', tags: { comment: 'keep this' } }, { title: 'Grey Evening', tags: { comment: 'also keep this' } },
      ],
    })
    const files = await scan(folder.id)
    const albumId = files[0]!.albumId!
    const url = `albums/${albumId}/tags`
    expect((await app.inject({ url: '/api/v1/admin/' + url })).statusCode).toBe(401)
    const editor = TagEditor.parse((await call(url)).json())
    const cover = Buffer.from((await parseFile(paths[0]!)).common.picture![0]!.data).toString('base64')
    const result = await call(url, {
      method: 'PATCH', payload: {
        album: { album: 'New Title', albumArtist: 'Mira Vale', date: '2025-09-21', discTotal: 2, compilation: true, genres: ['Jazz'] },
        tracks: editor.tracks.map((row, index) => ({
          id: row.id, revision: row.revision, tags: index === 0 ? {
            title: 'Blue Morning', artist: 'A New Credit', disc: 1, track: 1, composer: ['Composer A'], lyricist: ['Lyricist A'],
            arranger: ['Arranger A'], producer: ['Producer A'],
          } : { track: 2, disc: 1 },
        })),
        cover: { mode: 'both', image: { base64: cover } },
      },
    })
    expect(result.statusCode).toBe(200)
    expect(TagEditResult.parse(result.json())).toEqual({ written: files.map(file => file.id), errors: [] })
    await drainJobs()
    const after = await db.select().from(mediaFiles).where(eq(mediaFiles.rootId, folder.id)).orderBy(asc(mediaFiles.relPath))
    expect(after.map(file => [file.id, file.audioHash])).toEqual(files.map(file => [file.id, file.audioHash]))
    expect(after[0]?.tags).toMatchObject({
      title: 'Blue Morning', artist: 'A New Credit', album: 'New Title', date: '2025-09-21', discTotal: 2,
      genres: ['Jazz'], comment: 'keep this', compilation: true, credits: expect.arrayContaining([
        expect.objectContaining({ role: 'composer', name: 'Composer A' }),
        expect.objectContaining({ role: 'lyricist', name: 'Lyricist A' }),
        expect.objectContaining({ role: 'arranger', name: 'Arranger A' }),
        expect.objectContaining({ role: 'producer', name: 'Producer A' }),
      ]),
    })
    expect(after[1]?.tags).toMatchObject({ title: 'Grey Evening', comment: 'also keep this' })
    expect(after[0]?.groupKey).toBe(after[1]?.groupKey)
    expect(after[0]?.groupKey).not.toBe(files[0]?.groupKey)
    expect(after.every(file => file.recordingId && file.embeddedArtAssetId)).toBe(true)
    const [album] = await db.select().from(albums).where(eq(albums.id, after[0]!.albumId!))
    expect(album).toMatchObject({ title: 'New Title', artworkLocked: true })
    expect((await stat(path.join(path.dirname(paths[0]!), 'cover.jpg'))).isFile()).toBe(true)
  })

  it('preserves a locked match and refuses a stale revision and read-only files', async () => {
    for (const mode of ['managed', 'read_only'] as const) {
      const folder = await root(mode)
      const [filePath] = await makeAlbum(folder.path, { artist: 'Maple', album: mode, tracks: [{ title: 'Original' }] })
      const [file] = await scan(folder.id)
      await db.update(mediaFiles).set({ matchLocked: true, matchStatus: 'unmatched' }).where(eq(mediaFiles.id, file!.id))
      const url = `albums/${file!.albumId}/tags`
      const { revision, reason } = TagEditor.parse((await call(url)).json()).tracks[0]!
      expect(!!reason).toBe(mode === 'read_only')
      const edit = (version: string) => call(url, {
        method: 'PATCH', payload: { album: {}, tracks: [{ id: file!.id, revision: version, tags: { title: 'New Song' } }] },
      })
      expect(TagEditResult.parse((await edit('stale')).json()).written).toEqual([])
      const result = TagEditResult.parse((await edit(revision)).json())
      expect(result.written).toEqual(mode === 'managed' ? [file!.id] : [])
      await drainJobs()
      const [current] = await db.select().from(mediaFiles).where(eq(mediaFiles.id, file!.id))
      expect(current).toMatchObject({ matchLocked: true, recordingId: file!.recordingId, releaseId: file!.releaseId })
      expect((await parseFile(filePath!)).common.title).toBe(mode === 'managed' ? 'New Song' : 'Original')
    }
  })

  it('compares encodings and hashes, and deletes only a present managed duplicate', async () => {
    const managed = await root()
    const readOnly = await root('read_only')
    const spec = { artist: 'Recording Test Artist', album: 'Two Copies', tracks: [{ title: 'Layer One', durationSec: 3 }] }
    await makeAlbum(managed.path, { ...spec, format: 'mp3' })
    const [original] = await makeAlbum(readOnly.path, { ...spec, format: 'flac' })
    const [lossy] = await scan(managed.id)
    const [lossless] = await scan(readOnly.id)
    await copyFile(original!, path.join(managed.path, 'exact.flac'))
    const files = await scan(managed.id)
    const exact = files.find(file => file.relPath === 'exact.flac')!
    const groups = DuplicatePage.parse((await call('library/duplicates')).json()).items
    const encodings = groups.find(group => group.reason === 'tags' && group.files.some(file => file.id === lossy!.id))!
    expect(encodings.files.map(file => file.id)).toEqual(expect.arrayContaining([lossless!.id, lossy!.id]))
    expect(encodings.bestId).not.toBe(lossy!.id)
    expect(groups.some(group => group.reason === 'audio' && group.files.some(file => file.id === exact.id))).toBe(true)
    expect(DuplicatePage.parse((await call('library/duplicates?kind=albums')).json()).items.some(group => group.label === spec.album)).toBe(true)
    expect(QualityPage.parse((await call('library/quality')).json()).items.some(file => file.id === lossy!.id)).toBe(true)
    const remove = (which: string, keepId: string, revision: string) => call('library/duplicates/' + which, {
      method: 'DELETE', payload: { keepId, revision, reason: 'tags' },
    })
    const originalCopy = encodings.files.find(file => file.id === lossless!.id)!
    const compressedCopy = encodings.files.find(file => file.id === lossy!.id)!
    expect((await remove(originalCopy.id, compressedCopy.id, originalCopy.revision)).statusCode).toBe(409)
    expect((await remove(compressedCopy.id, originalCopy.id, 'stale')).statusCode).toBe(409)
    expect((await remove(compressedCopy.id, originalCopy.id, compressedCopy.revision)).statusCode).toBe(200)
    await expect(stat(compressedCopy.path)).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await stat(original!)).isFile()).toBe(true)
  })

  it('finds corrupt audio and hash mismatches, and resumes manual checks with the schedule off', async () => {
    const folder = await root('read_only')
    const file = await makeTone(folder.path, { path: 'health.flac', durationSec: 4 })
    const other = await makeTone(folder.path, { path: 'ok.flac', durationSec: 1, frequency: 550 })
    const [corrupt, healthy] = await scan(folder.id)
    expect(await inspectAudio(other, corrupt!.audioHash)).toMatchObject({ status: 'hash_changed' })
    const bytes = await readFile(file)
    bytes.fill(0, Math.floor(bytes.length * 0.7), Math.floor(bytes.length * 0.8))
    await writeFile(file, bytes)
    await scrubFiles()
    const page = async () => HealthPage.parse((await call('library/file-health')).json()).items
    expect((await page()).find(f => f.id === corrupt!.id)?.status).toBeNull()
    for (const id of [corrupt!.id, healthy!.id]) expect((await call('library/file-health/' + id, { method: 'POST' })).statusCode).toBe(202)
    await drainJobs()
    // If the second request arrived during the first check, the next tick picks it up.
    await scrubFiles()
    const files = await page()
    expect(files.find(f => f.id === corrupt!.id)).toMatchObject({ status: 'decode_error', pending: false, folder: folder.path })
    expect(files.find(f => f.id === healthy!.id)).toMatchObject({ status: 'healthy', pending: false })
    expect(HealthPage.parse((await call('library/file-health?issues=true')).json()).items.map(f => f.id)).not.toContain(healthy!.id)
    expect(await audioHash(other)).toBe(healthy!.audioHash)
  })
})
