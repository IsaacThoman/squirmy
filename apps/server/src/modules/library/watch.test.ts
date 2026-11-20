import { mkdir, mkdtemp, realpath, rename, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { eq, isNotNull } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { db } from '../../database/client.js'
import { albums, libraryRoots, mediaFiles } from '../../database/schema.js'
import { drainJobs, jobs, startJobs, stopJobs } from '../../jobs/index.js'
import { makeAlbum, makeTone } from '../../test/audio.js'
import { useTestDatabase } from '../../test/database.js'
import { libraryModule } from './index.js'
import { stopProgress } from './progress.js'
import { insertRoot } from './roots.js'
import { scanRoot } from './scan.js'
import { refreshWatchers, startWatching, stopWatching } from './watch.js'

describe('library watcher', () => {
  useTestDatabase()
  let library = ''
  let staging = ''
  let rootId = ''

  // Files are written elsewhere and moved in whole, so a scan never sees half a file.
  const moveIn = async (relPath: string) => {
    await mkdir(path.dirname(path.join(library, relPath)), { recursive: true })
    await rename(path.join(staging, relPath), path.join(library, relPath))
  }

  const settle = async (check: () => Promise<boolean>) => {
    await expect.poll(async () => {
      await drainJobs()
      return check()
    }, { timeout: 15_000, interval: 200 }).toBe(true)
  }

  beforeAll(async () => {
    library = await realpath(await mkdtemp(path.join(tmpdir(), 'squirmy-watch-')))
    staging = await realpath(await mkdtemp(path.join(tmpdir(), 'squirmy-staging-')))
    await makeAlbum(library, { artist: 'Mira Vale', album: 'Blue Hour', tracks: [{ title: 'Night Swimming', durationSec: 1 }] })
    await libraryModule.jobs!(jobs)
    await startJobs({ work: true })
    rootId = (await insertRoot({ name: 'Music', path: library, mode: 'read_only', watch: true })).id
    await scanRoot({ rootId })
    await drainJobs()
    await startWatching({ debounceMs: 150, maxWaitMs: 1000, retryMs: 300 })
  })
  afterAll(async () => {
    await stopWatching()
    await stopJobs()
    // Its debounce timers would otherwise fire after the database is gone.
    await stopProgress()
    await rm(library, { recursive: true, force: true })
    await rm(staging, { recursive: true, force: true })
  })

  it('picks up a new album', async () => {
    await makeAlbum(staging, { artist: 'Lune Park', album: 'Slow Motion', format: 'mp3', tracks: [{ title: 'Amber', durationSec: 1 }, { title: 'Riverside', durationSec: 1 }] })
    await moveIn('Lune Park')
    await settle(async () => (await db.select().from(albums).where(eq(albums.title, 'Slow Motion'))).length === 1)
    const files = await db.select().from(mediaFiles).where(eq(mediaFiles.albumId, (await db.select().from(albums).where(eq(albums.title, 'Slow Motion')))[0]!.id))
    expect(files).toHaveLength(2)
    // Only the new folder was scanned: a full scan would have stamped the root.
    const [root] = await db.select().from(libraryRoots).where(eq(libraryRoots.id, rootId))
    expect(root!.lastScanStats).toMatchObject({ filesSeen: 1 })
  })

  it('notices a changed file and a deleted folder', async () => {
    await makeTone(staging, { path: 'Mira Vale/Blue Hour/01 Night Swimming.flac', durationSec: 1, tags: { title: 'Night Swimming (Remaster)', artist: 'Mira Vale', album: 'Blue Hour', track: 1 } })
    await moveIn('Mira Vale/Blue Hour/01 Night Swimming.flac')
    await settle(async () => (await db.select().from(mediaFiles).where(eq(mediaFiles.relPath, 'Mira Vale/Blue Hour/01 Night Swimming.flac')))[0]?.tags.title === 'Night Swimming (Remaster)')
    await rm(path.join(library, 'Lune Park'), { recursive: true })
    await settle(async () => (await db.select().from(mediaFiles).where(isNotNull(mediaFiles.missingSince))).length === 2)
  })

  it('stops watching a root that has watching turned off', async () => {
    await db.update(libraryRoots).set({ watch: false }).where(eq(libraryRoots.id, rootId))
    await refreshWatchers()
    await makeAlbum(staging, { artist: 'Unwatched', album: 'Quiet', tracks: [{ title: 'Hush', durationSec: 1 }] })
    await moveIn('Unwatched')
    await new Promise((resolve) => setTimeout(resolve, 1000))
    await drainJobs()
    expect(await db.select().from(albums).where(eq(albums.title, 'Quiet'))).toHaveLength(0)
  })
})
