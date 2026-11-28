import { availableParallelism } from 'node:os'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    exclude: ['dist/**', 'node_modules/**'],
    // Database tests create one database per file, so files can run in parallel.
    pool: 'forks',
    // Each file may use several query, worker and lock connections. Leave headroom
    // for setup and dedicated connections on Postgres's default 100-connection service.
    maxWorkers: Math.min(availableParallelism(), 8),
    globalSetup: ['src/test/global-setup.ts'],
    setupFiles: ['src/test/no-network.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
})
