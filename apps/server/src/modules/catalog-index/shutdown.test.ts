import { spawn, type ChildProcess } from 'node:child_process'
import { readdir } from 'node:fs/promises'
import { createServer, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { getConfig } from '../../config.js'
import { getSql } from '../../database/client.js'
import { enqueue, startJobs, stopJobs } from '../../jobs/index.js'
import { buildDump, testCatalog } from '../../test/catalog-index-dump.js'
import { useTestDatabase } from '../../test/database.js'
import { importJob, type ImportJob } from './routes.js'

const entry = fileURLToPath(new URL('../../index.ts', import.meta.url))

/** A worker process of the real server, as a deploy runs it. */
function startWorker(): ChildProcess {
  const config = getConfig()
  const env = {
    PATH: process.env.PATH,
    NODE_ENV: 'test',
    DATABASE_URL: config.DATABASE_URL,
    SQUIRMY_DATA_DIR: config.SQUIRMY_DATA_DIR,
    SQUIRMY_SECRET: 'test-secret-test-secret-test-secret',
    SQUIRMY_ROLE: 'worker',
    LOG_LEVEL: 'silent',
  }
  return spawn(process.execPath, ['--import', 'tsx', entry], { env, stdio: ['ignore', 'ignore', 'pipe'] })
}

function exited(child: ChildProcess) {
  return new Promise<number | null>((resolve) => {
    if (child.exitCode !== null) resolve(child.exitCode)
    else child.once('exit', (code) => resolve(code))
  })
}

async function until<T>(read: () => Promise<T | undefined>, what: string, timeoutMs = 45_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await read()
    if (value !== undefined) return value
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

type Row = { id: string; state: string; resumes: number; resumed_at: Date | null; recordings: number | null; checkpoint: unknown }
const importRow = async () => (await getSql()<Row[]>`select id, state, resumes, resumed_at, recordings, checkpoint from catalog_index_imports`)[0]
const stagingTables = async () => (await getSql()<{ name: string }[]>`
  select tablename as name from pg_tables where tablename like 'catalog\\_index\\_%' and tablename <> 'catalog_index_imports'`).map((row) => row.name)

describe('an import across a restart of the server', () => {
  useTestDatabase()
  const children: ChildProcess[] = []
  afterAll(async () => {
    for (const child of children) if (child.exitCode === null) child.kill('SIGKILL')
    await stopJobs()
  })

  it('stops on SIGTERM, keeps its work and finishes in the next process', async () => {
    const catalog = testCatalog()
    const dump = buildDump(catalog)
    // Sends the first 4 KB, then holds the rest until the gate opens, so the first process is
    // mid-download when it is stopped. Answers range requests, as data.metabrainz.org does.
    let open!: () => void
    const gate = new Promise<void>((resolve) => { open = resolve })
    const ranges: (string | undefined)[] = []
    const pending: ServerResponse[] = []
    const server = createServer((request, response) => {
      ranges.push(request.headers.range)
      pending.push(response)
      const from = Number(/^bytes=(\d+)-$/.exec(request.headers.range ?? '')?.[1] ?? 0)
      if (from > 0) {
        response.writeHead(206, { 'content-length': dump.length - from, 'content-range': `bytes ${from}-${dump.length - 1}/${dump.length}` })
        response.end(dump.subarray(from))
        return
      }
      response.writeHead(200, { 'content-length': dump.length })
      response.write(dump.subarray(0, 4096))
      void gate.then(() => response.end(dump.subarray(4096)))
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const source = `http://127.0.0.1:${(server.address() as AddressInfo).port}/dump.tar.zst`

    try {
      await startJobs({ work: false })
      await enqueue<ImportJob>(importJob, { source, recordingsPerArtist: null }, { singletonKey: 'catalog-index', priority: -10 })

      const first = startWorker()
      children.push(first)
      await until(async () => {
        const [row] = await getSql()<{ bytes: number }[]>`select bytes_read::int as bytes from catalog_index_imports where state = 'running'`
        return row && row.bytes > 0 ? row : undefined
      }, 'the import to start downloading')

      first.kill('SIGTERM')
      expect(await exited(first)).toBe(0)
      const stopped = await importRow()
      expect(stopped).toMatchObject({ state: 'interrupted', resumes: 0, checkpoint: expect.objectContaining({ built: 0 }) })
      expect(await stagingTables()).toEqual(expect.arrayContaining(['catalog_index_raw', 'catalog_index_raw_redirects', 'catalog_index_raw_releases']))
      const downloads = path.join(getConfig().SQUIRMY_DATA_DIR, 'catalog-index')
      expect(await readdir(downloads)).toEqual([`${stopped!.id}.tar.zst`])
      // The stopping process queued the resume itself.
      const [resume] = await getSql()<{ key: string }[]>`
        update pgboss.job set start_after = now() where name = ${importJob} and state = 'created' returning singleton_key as key`
      expect(resume?.key).toBe(`catalog-index:resume:${stopped!.id}:0`)

      open()
      const second = startWorker()
      children.push(second)
      const done = await until(async () => {
        const row = await importRow()
        return row?.state === 'active' || row?.state === 'failed' ? row : undefined
      }, 'the import to finish')
      expect(done).toMatchObject({ id: stopped!.id, state: 'active', resumes: 1, resumed_at: expect.any(Date), recordings: catalog.recordings.length, checkpoint: null })
      expect(ranges[0]).toBeUndefined()
      expect(ranges[1]).toMatch(/^bytes=[1-9]\d*-$/)
      const [counts] = await getSql()<{ recordings: number; albums: number; artists: number }[]>`
        select count(*) filter (where kind = 'recording')::int as recordings, count(*) filter (where kind = 'album')::int as albums,
               count(*) filter (where kind = 'artist')::int as artists
        from catalog_index`
      expect(counts).toEqual({ recordings: catalog.recordings.length, albums: 11, artists: 9 })
      expect(await stagingTables()).toEqual([])
      expect(await readdir(downloads)).toEqual([])

      second.kill('SIGTERM')
      expect(await exited(second)).toBe(0)
    } finally {
      for (const response of pending) response.destroy()
      server.close()
    }
  }, 120_000)
})
