import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { link, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { INCOMING_FOLDER } from '@squirmy/contracts'
import { and, eq, sql } from 'drizzle-orm'
import sharp from 'sharp'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { buildApp } from '../../app.js'
import { db } from '../../database/client.js'
import { albums, imports, mediaFiles, organizeBatches, recordings, wants } from '../../database/schema.js'
import { drainJobs, jobs, startJobs, stopJobs } from '../../jobs/index.js'
import { updateServerSettings } from '../../lib/settings.js'
import { signIn } from '../../test/api.js'
import { makeAlbum, makeTone } from '../../test/audio.js'
import { useTestDatabase } from '../../test/database.js'
import { createAlbum, createUser } from '../../test/factories.js'
import { useHttpFixtures } from '../../test/http.js'
import { demoAlbums } from '../../test/matching.js'
import { libraryModule } from '../library/index.js'
import { insertRoot } from '../library/roots.js'
import { scanRoot } from '../library/scan.js'
import { matchingModule } from '../matching/index.js'
import { realFileOps, type FileOps } from '../organize/files.js'
import { planOrganize } from '../organize/plan.js'
import { wantEntity } from '../userdata/wants.js'
import { processImport, runStep, type ProcessOptions } from './process.js'
import { addImportFile, commitImport, createImport, getImport, type ImportWork } from './service.js'
import { stagingDir, stagingRoot } from './staging.js'
import { writeZip } from './test-zip.js'

const okComputerGroup = 'b1392450-e666-3926-a536-22c65f834433'
const karmaPolice = '9e2ad5bc-c6f9-40d2-a36f-3122ee2072a3'
const fast: ProcessOptions = { pollMs: 50, identifyTimeoutMs: 120_000 }

/**
 * OK Computer as tagged tones with the real running times, so the matcher is confident.
 * `pitch` shifts every tone, which gives a second copy different audio (and hashes).
 */
async function okComputer(dir: string, folder: string, pitch = 0): Promise<string[]> {
  const tracks = demoAlbums.okComputer.tracks
  return Promise.all(tracks.map((track, index) => makeTone(dir, {
    path: `${folder}/${String(index + 1).padStart(2, '0')} ${track.title}.flac`,
    durationSec: track.durationMs / 1000,
    frequency: 220 + index * 40 + pitch,
    tags: { title: track.title, artist: 'Radiohead', album_artist: 'Radiohead', album: 'OK Computer', track: `${index + 1}/${tracks.length}`, date: 1997 },
  })))
}

const tree = async (dir: string) => (await readdir(dir, { recursive: true, withFileTypes: true }).catch(() => []))
  .filter((entry) => entry.isFile()).map((entry) => path.relative(dir, path.join(entry.parentPath, entry.name)).split(path.sep).join('/')).sort()
const exists = (file: string) => readFile(file).then(() => true, () => false)

describe('import processing', () => {
  useTestDatabase()
  const http = useHttpFixtures('musicbrainz', 'acoustid')
  let fixtures = ''
  let okFlac: string[] = []
  let okOther: string[] = []
  let cover: Buffer
  let uploader: Awaited<ReturnType<typeof createUser>>

  const managedRoot = async () => {
    const dir = await realpath(await mkdtemp(path.join(tmpdir(), 'squirmy-import-root-')))
    const root = await insertRoot({ name: path.basename(dir), path: dir, mode: 'managed', watch: false })
    await updateServerSettings({ importRootId: root.id })
    return root
  }
  /** Receives files into a new upload import, as the HTTP route does. */
  const receive = async (files: { from: string; to: string }[]) => {
    const created = await createImport({ kind: 'upload', userId: uploader.id })
    for (const file of files) {
      const result = await addImportFile(created.id, { filename: path.basename(file.to), relativePath: file.to, stream: createReadStream(file.from) })
      expect(result.status, file.to).toBe('accepted')
    }
    return created.id
  }
  const run = async (importId: string, options = fast) => {
    await commitImport(importId)
    await processImport(importId, options)
    return getImport(importId)
  }
  const rowsOf = (importId: string) => db.select().from(mediaFiles).where(eq(mediaFiles.importId, importId)).orderBy(mediaFiles.relPath)
  const inFolder = (files: string[], folder: string) => files.map((file) => ({ from: file, to: `${folder}/${path.basename(file)}` }))

  beforeAll(async () => {
    await libraryModule.jobs!(jobs)
    await matchingModule.jobs!(jobs)
    await startJobs({ work: true })
    fixtures = await mkdtemp(path.join(tmpdir(), 'squirmy-import-fixtures-'))
    okFlac = await okComputer(fixtures, 'ok')
    okOther = await okComputer(fixtures, 'ok-other', 7)
    cover = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#335577' } }).jpeg().toBuffer()
    uploader = await createUser({ canUpload: true })
  }, 120_000)

  afterAll(async () => {
    await stopJobs()
    await rm(fixtures, { recursive: true, force: true })
  })

  it('files an album identified from a zip, linking rows and fulfilling wants', async () => {
    const root = await managedRoot()
    // Someone browsed Karma Police and wanted it before anyone had it.
    const browsed = await createAlbum({ title: 'OK Computer', tracks: [{ title: 'Karma Police', mbid: karmaPolice }] })
    const fan = await createUser()
    await wantEntity(fan.id, 'track', browsed.tracks[0]!.recordingId)

    const archive = await writeZip(path.join(fixtures, 'OK Computer.zip'), [
      ...okFlac.map((file) => ({ name: `OK Computer/${path.basename(file)}`, data: file })),
      { name: 'OK Computer/cover.jpg', data: cover },
      { name: 'OK Computer/info.txt', data: Buffer.from('ripped with love') },
    ])
    const id = await receive([{ from: archive, to: 'OK Computer.zip' }])
    const done = await run(id)

    expect(done).toMatchObject({
      status: 'completed', step: null, timedOut: false, reviewFolder: null, error: null,
      counts: { filesReceived: 1, filesExtracted: 13, filesRejected: 1, archivesRejected: 0, audioFiles: 12, duplicatesSkipped: 0, albumsIdentified: 1, albumsFiled: 1, filesFiled: 12, filesLeftForReview: 0 },
    })
    const onDisk = await tree(root.path)
    expect(onDisk).toHaveLength(13)
    expect(onDisk.every((file) => file.startsWith('Radiohead/OK Computer (1997)/'))).toBe(true)
    expect(onDisk).toContain('Radiohead/OK Computer (1997)/cover.jpg')
    expect(onDisk.filter((file) => file.endsWith('.flac')).map((file) => path.basename(file).slice(0, 3))).toEqual(
      Array.from({ length: 12 }, (_, index) => `${String(index + 1).padStart(2, '0')} `))
    expect(await readdir(path.join(root.path, INCOMING_FOLDER)).catch(() => null)).toBeNull()
    expect(await readdir(stagingDir(id)).catch(() => null)).toBeNull()

    const rows = await rowsOf(id)
    expect(rows).toHaveLength(12)
    expect(rows.map((row) => row.relPath).sort()).toEqual(onDisk.filter((file) => file.endsWith('.flac')))
    expect(rows.every((row) => row.source === 'upload' && row.matchStatus === 'matched' && row.probeStage === 2 && row.audioHash)).toBe(true)
    const [album] = await db.select().from(albums).where(eq(albums.id, rows[0]!.albumId!))
    expect(album).toMatchObject({ mbid: okComputerGroup, title: 'OK Computer' })
    const [linked] = await db.select({ id: recordings.id }).from(recordings).where(eq(recordings.mbid, karmaPolice))
    expect(rows.some((row) => row.recordingId === linked!.id)).toBe(true)
    const [want] = await db.select().from(wants).where(eq(wants.userId, fan.id))
    expect(want!.fulfilledAt).not.toBeNull()
  }, 120_000)

  it('removes audio the library already has, and repeats within one import', async () => {
    const root = await managedRoot()
    const before = await db.select({ count: sql<number>`count(*)::int` }).from(mediaFiles)
    const id = await receive([...inFolder(okFlac, 'Again'), { from: okFlac[0]!, to: 'Again/copy of the first.flac' }])
    const done = await run(id)
    // Whatever is left says why: a file that could not be analyzed keeps no hash to compare.
    const left = await db.select({ relPath: mediaFiles.relPath, probeStage: mediaFiles.probeStage, probeError: mediaFiles.probeError }).from(mediaFiles).where(eq(mediaFiles.importId, id))
    expect({ ...done.counts, left }).toMatchObject({ audioFiles: 13, duplicatesSkipped: 13, filesFiled: 0, filesLeftForReview: 0, left: [] })
    expect(await tree(root.path)).toEqual([])
    expect(await db.select({ count: sql<number>`count(*)::int` }).from(mediaFiles)).toEqual(before)
  })

  it('leaves an unidentified album in _Incoming, playable, after copying it across file systems', async () => {
    const root = await managedRoot()
    const blueHour = await makeAlbum(fixtures, {
      artist: 'Mira Vale', album: 'Blue Hour', year: 2025, folder: 'blue',
      tracks: demoAlbums.blueHour.tracks.map((track) => ({ title: track.title, durationSec: 1 })),
    })
    // Staging and the root on different file systems: link() and rename() out of staging fail.
    let copies = 0
    const acrossDevices = <T extends (from: string, to: string, ...rest: never[]) => Promise<void>>(real: T) =>
      (async (from: string, to: string, ...rest: never[]) => {
        if (from.startsWith(stagingRoot())) throw Object.assign(new Error('cross-device link not permitted'), { code: 'EXDEV' })
        return real(from, to, ...rest)
      }) as T
    const ops: FileOps = {
      link: acrossDevices(realFileOps.link),
      rename: acrossDevices(realFileOps.rename),
      copyFile: async (from, to, mode) => {
        copies += 1
        await realFileOps.copyFile(from, to, mode)
      },
    }
    const id = await receive(inFolder(blueHour, 'Blue Hour'))
    const done = await run(id, { ...fast, ops })

    expect(copies).toBe(5)
    expect(done).toMatchObject({ status: 'completed', reviewFolder: `${INCOMING_FOLDER}/${id}`, counts: { audioFiles: 5, albumsIdentified: 0, filesFiled: 0, filesLeftForReview: 5 } })
    expect(await tree(root.path)).toEqual(blueHour.map((file) => `${INCOMING_FOLDER}/${id}/Blue Hour/${path.basename(file)}`))
    const rows = await rowsOf(id)
    expect(rows.every((row) => row.matchStatus === 'unmatched' && row.recordingId && row.source === 'upload')).toBe(true)

    const app = await buildApp()
    const listener = await signIn()
    const playback = await app.inject({ url: `/api/v1/tracks/${rows[0]!.recordingId}/playback`, headers: listener.headers })
    expect(playback.statusCode, playback.body).toBe(200)
    await app.close()
  })

  describe('with an AcoustID key', () => {
    let lookups: string[] = []
    beforeEach(async () => {
      lookups = []
      const fixture = JSON.parse(await readFile(new URL('../../test/http/acoustid/post-api-acoustid-org-v2-lookup-karma-police.json', import.meta.url), 'utf8'))
      const recorded = globalThis.fetch
      // The fingerprint is fpcalc's real one, which no recorded fixture can know in advance.
      globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        if (String(input) !== 'https://api.acoustid.org/v2/lookup') return recorded(input, init)
        lookups.push(String(init?.body))
        return new Response(JSON.stringify(fixture.response.json), { status: 200, headers: { 'content-type': 'application/json' } })
      }) as typeof fetch
    })

    it('identifies an untagged file by its fingerprint and files it', async () => {
      await managedRoot()
      await updateServerSettings({ acoustIdKey: 'test-acoustid-key' })
      const untagged = await makeTone(fixtures, { path: 'untagged/track01.flac', durationSec: 261 })
      const id = await receive([{ from: untagged, to: 'track01.flac' }])
      const done = await run(id)
      await updateServerSettings({ acoustIdKey: null })

      expect(lookups).toHaveLength(1)
      expect(lookups[0]).toMatch(/^client=test-acoustid-key&meta=recordings&duration=261&fingerprint=AQA/)
      const [row] = await rowsOf(id)
      expect(row).toMatchObject({ matchStatus: 'matched', matchSource: 'acoustid', acoustid: '5f8a2c1e-9b7d-4e3a-8c6f-2d1b0a9e8f7c' })
      const [recording] = await db.select().from(recordings).where(eq(recordings.id, row!.recordingId!))
      expect(recording).toMatchObject({ mbid: karmaPolice, title: 'Karma Police' })
      expect(done.counts).toMatchObject({ albumsIdentified: 1, filesFiled: 1, filesLeftForReview: 0 })
      expect(row!.relPath.startsWith('Radiohead/')).toBe(true)
      expect(http.requests.some((request) => request.includes('/recording/9e2ad5bc'))).toBe(true)
    })
  })

  it('resumes after a crash at every step', async () => {
    const root = await managedRoot()
    const albumZip = await writeZip(path.join(fixtures, 'ok-other.zip'), okOther.map((file) => ({ name: `OK Computer/${path.basename(file)}`, data: file })))
    const extrasZip = await writeZip(path.join(fixtures, 'extras.zip'), [{ name: 'Extras/folder.jpg', data: cover }])
    const id = await receive([{ from: albumZip, to: 'OK Computer.zip' }, { from: extrasZip, to: 'Extras.zip' }])
    await commitImport(id)
    const staging = stagingDir(id)
    const work = async () => (await db.select({ work: imports.work }).from(imports).where(eq(imports.id, id)))[0]!.work as ImportWork
    const step = async () => (await getImport(id)).step

    // extracting: one archive was half extracted, the other extracted but not yet deleted.
    const partial = path.join(staging, `.squirmy-extract-${createHash('sha256').update('OK Computer.zip').digest('hex').slice(0, 16)}`)
    await mkdir(partial, { recursive: true })
    await writeFile(path.join(partial, '01 Airbag.flac'), 'half a file')
    await mkdir(path.join(staging, 'Extras'))
    await writeFile(path.join(staging, 'Extras/folder.jpg'), cover)
    await db.update(imports).set({ work: { archives: { 'OK Computer.zip': { target: 'OK Computer' }, 'Extras.zip': { target: 'Extras' } } } }).where(eq(imports.id, id))
    await runStep(id, fast)
    expect(await step()).toBe('moving')
    expect(await tree(staging)).toEqual(['Extras/folder.jpg', ...okOther.map((file) => `OK Computer/${path.basename(file)}`)])
    expect(await readFile(path.join(staging, 'OK Computer', path.basename(okOther[0]!)))).toEqual(await readFile(okOther[0]!))
    expect((await work()).archives).toMatchObject({ 'OK Computer.zip': { target: 'OK Computer', extracted: 12, done: true }, 'Extras.zip': { target: 'Extras', done: true } })

    // moving: five files had moved, and the sixth was linked but not yet unlinked.
    const destination = path.join(root.path, INCOMING_FOLDER, id, 'OK Computer')
    await mkdir(destination, { recursive: true })
    const names = okOther.map((file) => path.basename(file))
    for (const name of names.slice(0, 5)) await rename(path.join(staging, 'OK Computer', name), path.join(destination, name))
    await link(path.join(staging, 'OK Computer', names[5]!), path.join(destination, names[5]!))
    // A scan while the import is moving leaves its folder alone.
    await scanRoot({ rootId: root.id })
    expect(await db.select().from(mediaFiles).where(eq(mediaFiles.rootId, root.id))).toEqual([])
    await runStep(id, fast)
    expect(await step()).toBe('identifying')
    expect(await tree(path.join(root.path, INCOMING_FOLDER, id))).toEqual(['Extras/folder.jpg', ...names.map((name) => `OK Computer/${name}`)])
    expect(await exists(staging)).toBe(false)

    // identifying: the scan and the pipeline had already run before the crash.
    await scanRoot({ rootId: root.id, paths: [`${INCOMING_FOLDER}/${id}`] })
    await drainJobs({ timeoutMs: 60_000 })
    await runStep(id, fast)
    expect(await step()).toBe('filing')
    expect((await rowsOf(id)).every((row) => row.matchStatus === 'matched' && row.source === 'upload')).toBe(true)

    // filing: the batch was planned, then the process died before applying it.
    const [first] = await rowsOf(id)
    const batchId = await planOrganize({ rootId: root.id, albumIds: [first!.albumId!], includeIncoming: true, userId: null })
    await db.update(imports).set({ work: { ...await work(), batchId } }).where(eq(imports.id, id))
    await runStep(id, fast)
    const done = await getImport(id)
    expect(done).toMatchObject({ status: 'completed', counts: { audioFiles: 12, filesFiled: 12, albumsFiled: 1, filesLeftForReview: 0 } })
    expect(await db.select({ id: organizeBatches.id, status: organizeBatches.status }).from(organizeBatches).where(eq(organizeBatches.rootId, root.id)))
      .toEqual([{ id: batchId, status: 'applied' }])
    expect((await tree(root.path)).every((file) => file.startsWith('Radiohead/OK Computer (1997)/'))).toBe(true)
    expect(await exists(path.join(root.path, INCOMING_FOLDER))).toBe(false)
  }, 120_000)

  it('reports what is still pending at the time limit as left for review', async () => {
    const root = await managedRoot()
    // Untagged and without an AcoustID key, so matching asks no one.
    const tone = await makeTone(fixtures, { path: 'late/late.flac', durationSec: 1 })
    const id = await receive([{ from: tone, to: 'late.flac' }])
    await commitImport(id)
    await runStep(id, fast)
    await runStep(id, fast)
    // The clock counts from when identification started, also across a restart.
    await db.update(imports).set({ stepStartedAt: new Date(Date.now() - 2 * 60 * 60_000) }).where(eq(imports.id, id))
    await runStep(id, { pollMs: 50 })
    await runStep(id, fast)
    expect(await getImport(id)).toMatchObject({ status: 'completed', timedOut: true, reviewFolder: `${INCOMING_FOLDER}/${id}`, counts: { filesLeftForReview: 1 } })
    expect(await tree(root.path)).toEqual([`${INCOMING_FOLDER}/${id}/late.flac`])
    await drainJobs({ timeoutMs: 60_000 })
    // The scan it queued still brings the file into the library.
    expect(await db.select({ importId: mediaFiles.importId }).from(mediaFiles).where(and(eq(mediaFiles.rootId, root.id)))).toHaveLength(1)
  })
})
