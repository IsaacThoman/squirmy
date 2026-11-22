import { mkdtemp, realpath, rename, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { asc, eq, sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { db } from '../../database/client.js'
import { mediaFiles } from '../../database/schema.js'
import { startJobs, stopJobs } from '../../jobs/index.js'
import { makeAlbum } from '../../test/audio.js'
import { useTestDatabase } from '../../test/database.js'
import { analyzeFile } from './analyze.js'
import { probeFile } from './probe.js'
import { stopProgress } from './progress.js'
import { insertRoot } from './roots.js'
import { scanRoot } from './scan.js'

/** Files under `_Fetched/`, the folder Organize files provider deliveries in. */
describe('the fetched folder', () => {
  useTestDatabase()
  const dirs: string[] = []
  const folder = async () => {
    const dir = await realpath(await mkdtemp(path.join(tmpdir(), 'squirmy-fetched-')))
    dirs.push(dir)
    return dir
  }
  const filesOf = (rootId: string) => db.select().from(mediaFiles).where(eq(mediaFiles.rootId, rootId)).orderBy(asc(mediaFiles.relPath))
  const album = (dir: string, folderPath: string) => makeAlbum(dir, {
    artist: 'Cache Act', album: 'Heard Once', folder: folderPath, tracks: [{ title: 'Sampled', durationSec: 1 }],
  })

  beforeAll(async () => {
    await startJobs({ work: false })
  })
  afterAll(async () => {
    await stopJobs()
    await stopProgress()
    for (const dir of dirs) await rm(dir, { recursive: true, force: true })
  })

  it('treats a file found under a managed root\'s _Fetched as a delivery, and nothing in a read-only root', async () => {
    const managedDir = await folder()
    await album(managedDir, '_Fetched/Cache Act/Heard Once')
    await album(managedDir, 'Cache Act/Mine')
    const managed = await insertRoot({ name: 'Managed', path: managedDir, mode: 'managed', watch: false })
    await scanRoot({ rootId: managed.id })
    expect((await filesOf(managed.id)).map((file) => [file.relPath.split('/')[0], file.source, file.cached])).toEqual([
      ['Cache Act', 'scan', false],
      ['_Fetched', 'provider:unknown', true],
    ])

    // A copy of a managed root, mounted read-only: the server never deletes there, so none of it is cache.
    const backupDir = await folder()
    await album(backupDir, '_Fetched/Cache Act/Heard Once')
    const backup = await insertRoot({ name: 'Backup', path: backupDir, mode: 'read_only', watch: false })
    await scanRoot({ rootId: backup.id })
    expect((await filesOf(backup.id)).map((file) => [file.source, file.cached])).toEqual([['scan', false]])
  })

  it('makes a delivery the owner moved out of _Fetched theirs', async () => {
    const dir = await folder()
    await album(dir, '_Fetched/Cache Act/Heard Once')
    const root = await insertRoot({ name: 'Moves', path: dir, mode: 'managed', watch: false })
    await scanRoot({ rootId: root.id })
    const [delivered] = await filesOf(root.id)
    await probeFile({ fileId: delivered!.id })
    await analyzeFile({ fileId: delivered!.id })
    await db.update(mediaFiles).set({ source: 'provider:test' }).where(eq(mediaFiles.id, delivered!.id))

    await rename(path.join(dir, '_Fetched', 'Cache Act'), path.join(dir, 'Kept'))
    await scanRoot({ rootId: root.id })
    for (const file of await db.select().from(mediaFiles).where(sql`${mediaFiles.rootId} = ${root.id} and ${mediaFiles.missingSince} is null`)) {
      await probeFile({ fileId: file.id })
      await analyzeFile({ fileId: file.id })
    }
    const after = await db.select().from(mediaFiles).where(eq(mediaFiles.id, delivered!.id))
    expect(after[0]).toMatchObject({ relPath: 'Kept/Heard Once/01 Sampled.flac', source: 'scan', cached: false, missingSince: null })
  })
})
