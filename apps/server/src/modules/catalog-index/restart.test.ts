import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { resetConfig } from '../../config.js'
import { closeDb, getSql } from '../../database/client.js'
import { runMigrations } from '../../database/migrate.js'
import { stopJobs } from '../../jobs/index.js'
import { buildDump, testCatalog } from '../../test/catalog-index-dump.js'
import { importCanonicalDump, ImportInterruptedError, resumeImport, type Checkpoint } from './import.js'

/**
 * Where Postgres's server programs are: on the PATH (Homebrew), or where Debian and
 * Ubuntu put them (GitHub's runners have one installed there, not running).
 */
function postgresBin(): string | null {
  if (!spawnSync('pg_ctl', ['--version']).error) return ''
  const root = '/usr/lib/postgresql'
  if (!existsSync(root)) return null
  const newest = readdirSync(root).filter((name) => /^\d+$/.test(name)).sort((a, b) => Number(b) - Number(a))[0]
  return newest && existsSync(path.join(root, newest, 'bin', 'pg_ctl')) ? path.join(root, newest, 'bin') : null
}

const bin = postgresBin()
const tool = (name: string) => (bin ? path.join(bin, name) : name)

async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as { port: number }
  await new Promise((resolve) => server.close(resolve))
  return port
}

// CI must run these, not skip them: GitHub's runners have the programs, and a green run
// should mean the restart cases passed. Elsewhere they need a local Postgres install.
it.runIf(bin === null && process.env.CI)('finds the Postgres server programs in CI', () => {
  expect(bin, 'pg_ctl is neither on the PATH nor under /usr/lib/postgresql').not.toBeNull()
})

/**
 * These restart a Postgres server, so they run on one of their own: the shared test
 * server is used by every other test file at the same time.
 */
describe.skipIf(bin === null)('the search index import across a restart of Postgres', () => {
  let root = ''
  let data = ''
  let port = 0
  const pgCtl = (...args: string[]) => execFileSync(tool('pg_ctl'), ['-D', data, ...args], { stdio: 'ignore' })
  // TCP only: a Unix socket under a long temporary path exceeds the 103-byte limit on macOS.
  const start = () => pgCtl('-w', '-l', path.join(root, 'postgres.log'), '-o', `-p ${port} -c listen_addresses=127.0.0.1 -c unix_socket_directories=''`, 'start')
  // Squirmy's connections die with the server; new ones are opened on the next query.
  const restart = async (mode: 'fast' | 'immediate') => {
    await closeDb()
    pgCtl('-w', '-m', mode, 'stop')
    start()
  }

  const catalog = testCatalog({ prefix: 'Restarted ' })
  let file = ''
  let expected: unknown[] = []
  const snapshot = async () => [...await getSql()`select kind, mbid, name, artist_name, album_name, score, head from catalog_index order by kind, mbid`]
  const stagingTables = async () => (await getSql()<{ name: string }[]>`
    select tablename as name from pg_tables where tablename like 'catalog\\_index\\_%' and tablename <> 'catalog_index_imports'`).map((row) => row.name)

  async function interrupted(stopAt: (checkpoint: Checkpoint) => boolean) {
    const controller = new AbortController()
    const error = await importCanonicalDump({
      source: file, chunkRecords: 7, signal: controller.signal,
      onCheckpoint: (checkpoint) => { if (stopAt(checkpoint)) controller.abort() },
    }).then(() => null, (failure: unknown) => failure)
    expect(error).toBeInstanceOf(ImportInterruptedError)
    return (error as ImportInterruptedError).id
  }

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'squirmy-pg-'))
    data = path.join(root, 'data')
    port = await freePort()
    execFileSync(tool('initdb'), ['-D', data, '-U', 'postgres', '--auth=trust', '--no-sync'], { stdio: 'ignore' })
    start()
    const url = `postgres://postgres@127.0.0.1:${port}/postgres`
    await runMigrations(url)
    process.env.NODE_ENV = 'test'
    process.env.DATABASE_URL = url
    process.env.SQUIRMY_DATA_DIR = root
    process.env.SQUIRMY_SECRET = 'test-secret-test-secret-test-secret'
    process.env.SQUIRMY_ROLE = 'all'
    process.env.LOG_LEVEL = 'silent'
    resetConfig()
    await closeDb()
    file = path.join(root, 'dump.tar.zst')
    await writeFile(file, buildDump(catalog))
    await importCanonicalDump({ source: file, chunkRecords: 7 })
    expected = await snapshot()
  }, 120_000)

  afterAll(async () => {
    await stopJobs()
    await closeDb({ final: true })
    if (data && existsSync(path.join(data, 'postmaster.pid'))) pgCtl('-w', '-m', 'immediate', 'stop')
    if (root) await rm(root, { recursive: true, force: true })
  })

  it('carries on after a clean restart: the unlogged staging tables survive it', async () => {
    const id = await interrupted((checkpoint) => checkpoint.built === 9)
    const [before] = await getSql()<{ started: string }[]>`select pg_postmaster_start_time()::text as started`
    await restart('fast')
    const [after] = await getSql()<{ started: string }[]>`select pg_postmaster_start_time()::text as started`
    expect(after!.started).not.toBe(before!.started)

    const seen: Checkpoint[] = []
    await resumeImport(id, { chunkRecords: 7, onCheckpoint: (checkpoint) => seen.push(checkpoint) })
    expect(seen[0]).toMatchObject({ built: 10 })
    expect(await snapshot()).toEqual(expected)
    expect(await stagingTables()).toEqual([])
  })

  it('carries on loading after a clean restart', async () => {
    const id = await interrupted((checkpoint) => (checkpoint.files['canonical_musicbrainz_data.csv']?.records ?? 0) >= 21)
    await restart('fast')
    const seen: Checkpoint[] = []
    await resumeImport(id, { chunkRecords: 7, onCheckpoint: (checkpoint) => seen.push(checkpoint) })
    expect(seen[0]!.files['canonical_musicbrainz_data.csv']).toEqual({ records: 28, done: false })
    expect(await snapshot()).toEqual(expected)
  })

  it('starts over after a crash, which empties the unlogged staging tables', async () => {
    const id = await interrupted((checkpoint) => (checkpoint.files['canonical_musicbrainz_data.csv']?.records ?? 0) >= 21)
    // A crash and the recovery that follows: unlogged tables come back empty.
    await getSql()`checkpoint`
    await restart('immediate')
    const [raw] = await getSql()<{ rows: number }[]>`select count(*)::int as rows from catalog_index_raw`
    expect(raw!.rows).toBe(0)

    const seen: Checkpoint[] = []
    await resumeImport(id, { chunkRecords: 7, onCheckpoint: (checkpoint) => seen.push(checkpoint) })
    expect(seen[0]).toMatchObject({ built: 0, files: {}, rows: 0 })
    expect(await snapshot()).toEqual(expected)
    expect(await stagingTables()).toEqual([])
  })
})
