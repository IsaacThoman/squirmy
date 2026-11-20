import { randomBytes } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import postgres from 'postgres'
import { afterAll, beforeAll } from 'vitest'
import { resetConfig } from '../config.js'
import { closeDb } from '../database/client.js'
import { stopJobs } from '../jobs/index.js'
import { adminUrl, databaseUrl } from './global-setup.js'

/**
 * Gives the current test file its own migrated database and data directory.
 * Call it at the top of a `describe` or at module scope:
 *
 *   useTestDatabase()
 *   it('…', async () => { await db.insert(…) })
 */
export function useTestDatabase() {
  const name = `squirmy_test_${randomBytes(6).toString('hex')}`
  let dataDir: string | undefined

  beforeAll(async () => {
    const template = process.env.SQUIRMY_TEST_TEMPLATE
    if (!template) throw new Error('The vitest global setup did not run; check vitest.config.ts')
    const admin = postgres(adminUrl(), { max: 1, onnotice: () => {} })
    await admin.unsafe(`create database "${name}" template "${template}"`)
    await admin.end()

    dataDir = await mkdtemp(path.join(tmpdir(), 'squirmy-test-'))
    process.env.NODE_ENV = 'test'
    process.env.DATABASE_URL = databaseUrl(name)
    process.env.SQUIRMY_DATA_DIR = dataDir
    process.env.SQUIRMY_SECRET = 'test-secret-test-secret-test-secret'
    process.env.SQUIRMY_ROLE = 'all'
    process.env.LOG_LEVEL = 'silent'
    resetConfig()
    await closeDb()
  })

  afterAll(async () => {
    // pg-boss holds its own connections, which would fail loudly once the database is dropped.
    await stopJobs()
    // Final: nothing that outlives the file may reconnect to the database dropped below.
    await closeDb({ final: true })
    const admin = postgres(adminUrl(), { max: 1, onnotice: () => {} })
    await admin.unsafe(`drop database if exists "${name}" with (force)`)
    await admin.end()
    if (dataDir) await rm(dataDir, { recursive: true, force: true })
  })
}
