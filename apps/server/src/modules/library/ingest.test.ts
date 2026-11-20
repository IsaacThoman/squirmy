import { mkdtemp, realpath, rm, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { and, asc, eq, sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { db } from '../../database/client.js'
import { albums, mediaFiles } from '../../database/schema.js'
import { startJobs, stopJobs } from '../../jobs/index.js'
import { makeAlbum, makeTone } from '../../test/audio.js'
import { useTestDatabase } from '../../test/database.js'
import { ingestGroup } from './ingest.js'
import { probeFile } from './probe.js'
import { stopProgress } from './progress.js'
import { insertRoot } from './roots.js'
import { scanRoot } from './scan.js'

// Jobs are run by hand, so each test picks the order in which the two groups are ingested.
// The worker runs them concurrently and either may take the catalog lock first.
describe('ingesting a group that lost a file', () => {
  useTestDatabase()
  let library = ''
  let rootId = ''

  const filesUnder = (folder: string) => db.select().from(mediaFiles)
    .where(and(eq(mediaFiles.rootId, rootId), sql`${mediaFiles.relPath} like ${`${folder}/%`}`)).orderBy(asc(mediaFiles.relPath))
  const fileById = async (id: string) => (await db.select().from(mediaFiles).where(eq(mediaFiles.id, id)))[0]!
  const albumTitle = async (id: string) => (await db.select({ title: albums.title }).from(albums).where(eq(albums.id, id)))[0]?.title

  beforeAll(async () => {
    library = await realpath(await mkdtemp(path.join(tmpdir(), 'squirmy-ingest-')))
    await startJobs({ work: false })
    rootId = (await insertRoot({ name: 'Music', path: library, mode: 'read_only', watch: false })).id
  })
  afterAll(async () => {
    await stopJobs()
    // Its debounce timers would otherwise fire after the database is gone.
    await stopProgress()
    await rm(library, { recursive: true, force: true })
  })

  for (const order of ['left', 'joined'] as const) {
    it(`keeps the album with the files that stay when the group it ${order} is ingested first`, async () => {
      const folder = `Mira Vale/Blue Hour (${order})`
      const album = `Blue Hour (${order})`
      await makeAlbum(library, {
        artist: 'Mira Vale', album, folder,
        tracks: ['Night Swimming', 'Soft Signal', 'Underwater Light'].map((title) => ({ title, durationSec: 1 })),
      })
      await scanRoot({ rootId, paths: [folder] })
      for (const file of await filesUnder(folder)) await probeFile({ fileId: file.id })
      await ingestGroup({ rootId, groupKey: (await filesUnder(folder))[0]!.groupKey! })
      const [kept, other, leaving] = await filesUnder(folder) as [typeof mediaFiles.$inferSelect, typeof mediaFiles.$inferSelect, typeof mediaFiles.$inferSelect]
      const albumId = kept.albumId!
      expect([other.albumId, leaving.albumId]).toEqual([albumId, albumId])

      // Retag the last track onto an album of its own. The mtime is set explicitly so the
      // scan sees a change however close together the two writes were.
      const absolute = path.join(library, leaving.relPath)
      await makeTone(library, { path: leaving.relPath, durationSec: 1, tags: { title: 'Underwater Light', artist: 'Mira Vale', album_artist: 'Mira Vale', album: 'Underwater Light', track: 1 } })
      const later = new Date(leaving.mtime.getTime() + 60_000)
      await utimes(absolute, later, later)
      expect(await scanRoot({ rootId, paths: [folder] })).toMatchObject({ filesChanged: 1 })
      await probeFile({ fileId: leaving.id })
      const joined = (await fileById(leaving.id)).groupKey!
      expect(joined).not.toBe(kept.groupKey)

      const groups = order === 'left' ? [kept.groupKey!, joined] : [joined, kept.groupKey!]
      for (const groupKey of groups) await ingestGroup({ rootId, groupKey })

      expect((await fileById(kept.id)).albumId).toBe(albumId)
      expect((await fileById(other.id)).albumId).toBe(albumId)
      expect(await albumTitle(albumId)).toBe(album)
      const moved = (await fileById(leaving.id)).albumId!
      expect(moved).not.toBe(albumId)
      expect(await albumTitle(moved)).toBe('Underwater Light')
    })
  }
})
