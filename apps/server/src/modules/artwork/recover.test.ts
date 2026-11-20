import { access, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { eq, sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { parseFile } from 'music-metadata'
import sharp from 'sharp'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { buildApp } from '../../app.js'
import { db } from '../../database/client.js'
import { assets, mediaFiles } from '../../database/schema.js'
import { drainJobs, jobs, startJobs, stopJobs } from '../../jobs/index.js'
import { newId } from '../../lib/ids.js'
import { makeTone } from '../../test/audio.js'
import { useTestDatabase } from '../../test/database.js'
import { createLibraryRoot } from '../../test/factories.js'
import { storeEmbeddedPicture } from './files.js'
import { artworkModule } from './index.js'
import { recoverAsset, sweepArtwork } from './recover.js'
import { dataPath, remoteImage, storeImage, type Asset } from './store.js'

const picture = (color: string) => sharp({ create: { width: 64, height: 64, channels: 3, background: color } }).jpeg().toBuffer()

describe('lost artwork', () => {
  useTestDatabase()
  let app: FastifyInstance
  let folder = ''
  let served: Record<string, Buffer> = {}

  beforeAll(async () => {
    folder = await realpath(await mkdtemp(path.join(tmpdir(), 'squirmy-recover-')))
    await artworkModule.jobs!(jobs)
    await startJobs({ work: true })
    app = await buildApp()
  })
  afterEach(() => {
    served = {}
    vi.unstubAllGlobals()
  })
  afterAll(async () => {
    await app.close()
    await stopJobs()
    await rm(folder, { recursive: true, force: true })
  })

  const art = (id: string, size = 300) => app.inject({ url: `/api/v1/art/${id}/${size}` })
  const row = async (id: string) => (await db.select().from(assets).where(eq(assets.id, id)))[0]!
  /** Deletes an asset's original and its renditions, as losing the data folder would. */
  const lose = async (asset: Asset) => {
    await rm(dataPath((await row(asset.id)).storagePath!), { force: true })
    await rm(dataPath('art', asset.id), { recursive: true, force: true })
  }
  const original = async (asset: Asset) => readFile(dataPath((await row(asset.id)).storagePath!))
  /** Assets with an `artwork.recover` job queued since `since`, whether or not it ran yet. */
  const queued = async (since: Date) => (await db.execute<{ id: string }>(sql`
    select data->>'assetId' as id from pgboss.job where name = 'artwork.recover' and created_on >= ${since.toISOString()}::timestamptz`)).map((job) => job.id)
  const serve = () => vi.stubGlobal('fetch', async (input: string | URL | Request) => {
    const body = served[input.toString()]
    return body ? new Response(new Uint8Array(body), { status: 200, headers: { 'content-type': 'image/jpeg' } }) : new Response('nope', { status: 404 })
  })

  it('reads a folder image again while the request waits', async () => {
    const file = path.join(folder, 'cover.jpg')
    const bytes = await picture('#335577')
    await writeFile(file, bytes)
    const asset = await storeImage(bytes, { kind: 'cover', source: `folder:${file}` })
    await lose(asset)

    const response = await art(asset.id)
    expect(response.statusCode).toBe(200)
    expect(await original(asset)).toEqual(bytes)
  })

  it('extracts an embedded picture again, from any file that has it', async () => {
    const root = await createLibraryRoot({ path: folder })
    const file = await makeTone(folder, { path: 'Artist/Album/01.flac', durationSec: 1, cover: '#884422' })
    const { common } = await parseFile(file)
    const fileId = newId()
    await db.insert(mediaFiles).values({
      id: fileId, rootId: root.id, relPath: 'Artist/Album/01.flac', size: 1, mtime: new Date(), container: 'flac', codec: 'flac',
      lossless: true, durationMs: 1000, tags: {}, probeStage: 1,
    })
    const asset = (await storeEmbeddedPicture(fileId, { data: common.picture![0]!.data }))!
    await db.update(mediaFiles).set({ embeddedArtAssetId: asset.id }).where(eq(mediaFiles.id, fileId))
    const bytes = await original(asset)
    await lose(asset)

    expect((await art(asset.id)).statusCode).toBe(200)
    expect(await original(asset)).toEqual(bytes)
  })

  it('answers 404 without caching, and never retries, when nothing can rebuild it', async () => {
    const asset = await storeImage(await picture('#112233'), { kind: 'cover', source: 'upload:nowhere' })
    await lose(asset)
    const since = new Date()
    const response = await art(asset.id)
    expect(response.statusCode).toBe(404)
    expect(response.headers['cache-control']).toBeUndefined()
    expect(await row(asset.id)).toMatchObject({ status: 'missing' })
    expect((await art(asset.id, 96)).statusCode).toBe(404)
    expect(await queued(since)).not.toContain(asset.id)
  })

  it('downloads a cover again in a job and refuses a different picture', async () => {
    const url = 'https://images.example/front.jpg'
    const bytes = await picture('#557733')
    const asset = await storeImage(bytes, { kind: 'cover', source: url })
    await lose(asset)
    serve()
    served[url] = bytes

    const since = new Date()
    const first = await art(asset.id)
    expect(first.statusCode).toBe(404)
    expect(first.headers['cache-control']).toBeUndefined()
    expect(await queued(since)).toEqual([asset.id])
    await drainJobs()
    expect(await original(asset)).toEqual(bytes)
    expect((await art(asset.id)).statusCode).toBe(200)

    // The URL now serves another picture: the asset is marked missing rather than changed.
    await lose(asset)
    served[url] = await picture('#000099')
    await recoverAsset({ assetId: asset.id })
    expect(await row(asset.id)).toMatchObject({ status: 'missing' })
    expect((await art(asset.id)).statusCode).toBe(404)
  })

  it('downloads a remote image again as on its first request', async () => {
    const url = 'https://images.example/remote.jpg'
    serve()
    served[url] = await picture('#993355')
    const asset = await remoteImage(url, { kind: 'cover' })
    expect((await art(asset.id)).statusCode).toBe(200)
    await lose(asset)

    expect((await art(asset.id)).statusCode).toBe(404)
    await drainJobs()
    expect(await row(asset.id)).toMatchObject({ status: 'ready' })
    expect((await art(asset.id)).statusCode).toBe(200)
  })

  it('sweeps for lost files, and notices files that came back', async () => {
    const file = path.join(folder, 'folder.jpg')
    const bytes = await picture('#446688')
    await writeFile(file, bytes)
    const lost = await storeImage(bytes, { kind: 'cover', source: `folder:${file}` })
    const kept = await storeImage(await picture('#664488'), { kind: 'cover', source: 'upload:kept' })
    const gone = await storeImage(await picture('#886644'), { kind: 'cover', source: 'upload:gone' })
    const backup = await original(gone)
    await lose(lost)
    await lose(gone)

    const since = new Date()
    await sweepArtwork()
    expect(await queued(since)).toEqual(expect.arrayContaining([lost.id, gone.id]))
    expect(await queued(since)).not.toContain(kept.id)
    await drainJobs()
    await access(dataPath(lost.storagePath!))
    expect(await row(gone.id)).toMatchObject({ status: 'missing' })

    // Restored from a backup: the next sweep makes it ready again.
    await writeFile(dataPath(gone.storagePath!), backup)
    await sweepArtwork()
    await drainJobs()
    expect(await row(gone.id)).toMatchObject({ status: 'ready' })
    expect((await art(gone.id)).statusCode).toBe(200)

    // A missing asset whose source is still gone waits a week before the next try.
    await lose(gone)
    await recoverAsset({ assetId: gone.id })
    const later = new Date()
    await sweepArtwork()
    expect(await queued(later)).not.toContain(gone.id)
  })
})
