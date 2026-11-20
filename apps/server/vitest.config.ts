import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    exclude: ['dist/**', 'node_modules/**'],
    // Database tests create one database per file, so files can run in parallel.
    pool: 'forks',
    globalSetup: ['src/test/global-setup.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
})
