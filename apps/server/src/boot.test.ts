import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { databaseUrl } from './test/global-setup.js'

const run = promisify(execFile)
const entry = fileURLToPath(new URL('./index.ts', import.meta.url))

describe('boot', () => {
  let dataDir = ''
  beforeAll(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), 'squirmy-boot-'))
  })
  afterAll(async () => {
    await rm(dataDir, { recursive: true, force: true })
  })

  // docs/server/troubleshooting.md tells operators to look for this line after a bad upgrade.
  it('logs a failed migration as a failed start and exits with 1', async () => {
    const env = {
      PATH: process.env.PATH,
      NODE_ENV: 'test',
      DATABASE_URL: databaseUrl('squirmy_boot_missing_database'),
      SQUIRMY_DATA_DIR: dataDir,
      SQUIRMY_SECRET: 'test-secret-test-secret-test-secret',
      SQUIRMY_ROLE: 'worker',
      LOG_LEVEL: 'silent',
    }
    const failure = await run(process.execPath, ['--import', 'tsx', entry], { env, timeout: 20_000 }).then(
      () => null,
      (error: { code?: number; stderr?: string }) => error,
    )
    expect(failure).not.toBeNull()
    expect(failure!.code).toBe(1)
    expect(failure!.stderr).toContain('[squirmy] failed to start')
  })
})
