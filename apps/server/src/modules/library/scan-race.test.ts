import { mkdir, mkdtemp, realpath, rename, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { eq, sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '../../database/client.js'
import { mediaFiles } from '../../database/schema.js'
import { startJobs, stopJobs } from '../../jobs/index.js'
import { makeAlbum } from '../../test/audio.js'
import { useTestDatabase } from '../../test/database.js'
import { stopProgress } from './progress.js'
import { insertRoot } from './roots.js'
import { scanRoot } from './scan.js'

// Runs once before the next walk lists anything, after the scan has read its first rows.
const hooks = vi.hoisted(() => ({ beforeWalk: null as null | (() => Promise<void>) }))
vi.mock('./walk.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('./walk.js')>()
  return {
    ...original,
    walk: async function* (...args: Parameters<typeof original.walk>) {
      const hook = hooks.beforeWalk
      hooks.beforeWalk = null
      if (hook) await hook()
      yield* original.walk(...args)
    },
  }
})

describe('a scan racing a move', () => {
  useTestDatabase()
  let library = ''
  let rootId = ''

  beforeAll(async () => {
    library = await realpath(await mkdtemp(path.join(tmpdir(), 'squirmy-scan-race-')))
    await startJobs({ work: false })
    rootId = (await insertRoot({ name: 'Music', path: library, mode: 'read_only', watch: false })).id
  })
  afterAll(async () => {
    await stopJobs()
    await stopProgress()
    await rm(library, { recursive: true, force: true })
  })
  beforeEach(async () => {
    await rm(path.join(library, 'Incoming'), { recursive: true, force: true })
    await rm(path.join(library, 'Filed'), { recursive: true, force: true })
    await db.delete(mediaFiles)
  })

  async function oneFile() {
    await makeAlbum(library, { artist: 'Mira Vale', album: 'Blue Hour', folder: 'Incoming/Blue Hour', tracks: [{ title: 'Night Swimming', durationSec: 1 }] })
    await scanRoot({ rootId, paths: ['Incoming'] })
    const [file] = await db.select().from(mediaFiles).where(eq(mediaFiles.rootId, rootId))
    return file!
  }

  it('does not mark a file missing that moved between reading its row and walking its folder', async () => {
    const file = await oneFile()
    const to = `Filed/Blue Hour/${path.basename(file.relPath)}`
    // What Organize does when it files a delivery: the file moves, then its row follows.
    hooks.beforeWalk = async () => {
      await mkdir(path.join(library, 'Filed/Blue Hour'), { recursive: true })
      await rename(path.join(library, file.relPath), path.join(library, to))
      await db.update(mediaFiles).set({ relPath: to }).where(eq(mediaFiles.id, file.id))
    }
    const stats = await scanRoot({ rootId, paths: ['Incoming'] })
    expect(stats?.filesMissing).toBe(0)
    const [after] = await db.select().from(mediaFiles).where(eq(mediaFiles.id, file.id))
    expect(after).toMatchObject({ relPath: to, missingSince: null })
  })

  it('still marks a file missing that is gone', async () => {
    const file = await oneFile()
    await rm(path.join(library, file.relPath))
    const stats = await scanRoot({ rootId, paths: ['Incoming'] })
    expect(stats?.filesMissing).toBe(1)
    const [after] = await db.select({ missing: sql<boolean>`${mediaFiles.missingSince} is not null` }).from(mediaFiles).where(eq(mediaFiles.id, file.id))
    expect(after!.missing).toBe(true)
  })
})
