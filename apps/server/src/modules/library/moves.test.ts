import { mkdtemp, realpath, rename, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { asc, eq, sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { db } from '../../database/client.js'
import { albums, likes, mediaFiles } from '../../database/schema.js'
import { startJobs, stopJobs } from '../../jobs/index.js'
import { makeAlbum } from '../../test/audio.js'
import { useTestDatabase } from '../../test/database.js'
import { createUser } from '../../test/factories.js'
import { analyzeFile } from './analyze.js'
import { ingestGroup } from './ingest.js'
import { probeFile } from './probe.js'
import { insertRoot } from './roots.js'
import { scanRoot } from './scan.js'

// Jobs are run by hand here, in the order that is hardest on move detection.
describe('moving an album', () => {
  useTestDatabase()
  let library = ''
  let rootId = ''

  const filesUnder = (prefix: string) => db.select().from(mediaFiles).where(sql`${mediaFiles.relPath} like ${`${prefix}/%`}`).orderBy(asc(mediaFiles.relPath))
  const probeAll = async (prefix: string) => {
    for (const file of await filesUnder(prefix)) await probeFile({ fileId: file.id })
    for (const file of await filesUnder(prefix)) await ingestGroup({ rootId, groupKey: file.groupKey! })
  }

  beforeAll(async () => {
    library = await realpath(await mkdtemp(path.join(tmpdir(), 'squirmy-moves-')))
    await makeAlbum(library, {
      artist: 'Mira Vale', album: 'Blue Hour', folder: 'Before/Blue Hour',
      tracks: ['Night Swimming', 'Soft Signal', 'Blue in the Dark', 'Underwater Light'].map((title) => ({ title, durationSec: 1 })),
    })
    await startJobs({ work: false })
    rootId = (await insertRoot({ name: 'Music', path: library, mode: 'read_only', watch: false })).id
    await scanRoot({ rootId })
    await probeAll('Before')
    for (const file of await filesUnder('Before')) await analyzeFile({ fileId: file.id })
  })
  afterAll(async () => {
    await stopJobs()
    await rm(library, { recursive: true, force: true })
  })

  it('keeps the album when the group is ingested between each file being reconnected', async () => {
    const before = await filesUnder('Before')
    const albumId = before[0]!.albumId!
    const user = await createUser()
    await db.insert(likes).values({ userId: user.id, entityType: 'album', entityId: albumId })

    await rename(path.join(library, 'Before'), path.join(library, 'After'))
    await scanRoot({ rootId })
    // The new rows are probed and ingested first, so they get a duplicate album of their own.
    await probeAll('After')
    const groupKey = (await filesUnder('After'))[0]!.groupKey!
    expect(new Set((await filesUnder('After')).map((file) => file.albumId))).not.toContain(albumId)

    for (const file of await filesUnder('After')) {
      if (file.audioHash) continue
      await analyzeFile({ fileId: file.id })
      await ingestGroup({ rootId, groupKey })
    }

    const after = await filesUnder('After')
    expect(after.map((file) => file.id).sort()).toEqual(before.map((file) => file.id).sort())
    expect(new Set(after.map((file) => file.albumId))).toEqual(new Set([albumId]))
    expect(await db.select({ id: albums.id }).from(albums)).toEqual([{ id: albumId }])
    expect(await db.select().from(likes).where(eq(likes.entityId, albumId))).toHaveLength(1)
  })
})
