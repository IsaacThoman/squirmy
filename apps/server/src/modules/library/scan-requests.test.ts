import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { eq, sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { db } from '../../database/client.js'
import { libraryRoots } from '../../database/schema.js'
import { drainJobs, enqueue, jobs, startJobs, stopJobs } from '../../jobs/index.js'
import { newId } from '../../lib/ids.js'
import { makeAlbum } from '../../test/audio.js'
import { useTestDatabase } from '../../test/database.js'
import { libraryModule } from './index.js'
import { stopProgress } from './progress.js'
import { requestScan, runScan } from './roots.js'

type JobRow = { state: string; data: { rootId: string; paths?: string[] } }

// The nightly scan is the fallback for missed watch events, so a watcher or import scan
// holding the root's key must not make it disappear.
describe('full scan requests behind a partial scan', () => {
  useTestDatabase()
  let base = ''
  let rootId = ''

  const held = async (name: string) => db.execute<JobRow>(sql`
    select state, data from pgboss.job where name = ${name} and singleton_key = ${rootId} and state in ('created', 'retry', 'active')`)
  const clear = () => db.execute(sql`delete from pgboss.job where name in ('library.scan', 'library.scan-after')`)
  const partial = () => enqueue('library.scan', { rootId, paths: ['Mira Vale'] }, { singletonKey: rootId })
  const lastScan = async () => (await db.select().from(libraryRoots).where(eq(libraryRoots.id, rootId)))[0]!

  beforeAll(async () => {
    base = await realpath(await mkdtemp(path.join(tmpdir(), 'squirmy-scan-requests-')))
    await makeAlbum(path.join(base, 'Mira Vale'), { artist: 'Mira Vale', album: 'Blue Hour', tracks: [{ title: 'Night Swimming', durationSec: 1 }] })
    await makeAlbum(path.join(base, 'Other'), { artist: 'Other', album: 'Elsewhere', tracks: [{ title: 'Far', durationSec: 1 }] })
    rootId = newId()
    await db.insert(libraryRoots).values({ id: rootId, name: 'Music', path: base, mode: 'read_only', watch: false })
    // With workers off, jobs stay where the test puts them.
    await libraryModule.jobs!(jobs)
    await startJobs({ work: false })
  })
  afterAll(async () => {
    await stopJobs()
    await stopProgress()
    await rm(base, { recursive: true, force: true })
  })

  it('turns a queued partial scan into a full one', async () => {
    await clear()
    expect(await partial()).not.toBeNull()
    expect(await requestScan(rootId)).toBe(true)
    expect(await held('library.scan')).toEqual([{ state: 'created', data: { rootId } }])
    // A second request finds the full scan already queued.
    expect(await requestScan(rootId)).toBe(false)
  })

  it('queues a full scan after a running partial one, which runs it when it finishes', async () => {
    await clear()
    await partial()
    await db.execute(sql`update pgboss.job set state = 'active', started_on = now() where name = 'library.scan' and singleton_key = ${rootId}`)
    expect(await requestScan(rootId)).toBe(true)
    expect(await held('library.scan-after')).toEqual([{ state: 'created', data: { rootId } }])
    expect(await requestScan(rootId)).toBe(true)
    expect(await held('library.scan-after')).toHaveLength(1)

    // What the running partial scan's job does.
    await runScan({ rootId, paths: ['Mira Vale'] })
    expect(await held('library.scan-after')).toEqual([])
    expect((await lastScan()).lastScanStats).toMatchObject({ filesSeen: 2 })
  })

  it('reports a running full scan as already running', async () => {
    await clear()
    await enqueue('library.scan', { rootId }, { singletonKey: rootId })
    await db.execute(sql`update pgboss.job set state = 'active', started_on = now() where name = 'library.scan' and singleton_key = ${rootId}`)
    expect(await requestScan(rootId)).toBe(false)
    expect(await held('library.scan-after')).toEqual([])
  })

  it('runs a waiting full scan on its own when the partial scan did not pick it up', async () => {
    await clear()
    await db.update(libraryRoots).set({ lastScanStats: null }).where(eq(libraryRoots.id, rootId))
    await partial()
    await db.execute(sql`update pgboss.job set state = 'active', started_on = now() where name = 'library.scan' and singleton_key = ${rootId}`)
    expect(await requestScan(rootId)).toBe(true)
    // The partial scan's process died, and its job is gone; the follow-up's delay is over.
    await db.execute(sql`delete from pgboss.job where name = 'library.scan'`)
    await db.execute(sql`update pgboss.job set start_after = now() where name = 'library.scan-after'`)
    await stopJobs()
    await libraryModule.jobs!(jobs)
    await startJobs({ work: true })
    await drainJobs()
    expect((await lastScan()).lastScanStats).toMatchObject({ filesSeen: 2 })
  })
})
