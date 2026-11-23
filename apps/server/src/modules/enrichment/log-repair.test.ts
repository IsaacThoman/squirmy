import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetConfig } from '../../config.js'
import { logRepair } from './index.js'
import type { RepairReport } from './repair.js'

const report: RepairReport = {
  editions: 1, duplicateEditions: 0, unlinked: 2, artistCopies: 139, merged: 18, tagArtists: 0, decoded: 0, years: 0, explicitAlbums: 0,
  topTrackArtists: 0, rankedArtists: 0, imageArtists: 0, soundtrackChecks: 0, soundtracks: 0, twinAlbums: 11, twinsMerged: 20,
}

describe('logRepair', () => {
  const level = process.env.LOG_LEVEL
  const databaseUrl = process.env.DATABASE_URL
  beforeEach(() => {
    // The config needs a database address to parse; nothing here connects to it.
    process.env.DATABASE_URL ??= 'postgres://localhost:5432/unused'
  })
  afterEach(() => {
    process.env.LOG_LEVEL = level
    if (databaseUrl === undefined) delete process.env.DATABASE_URL
    else process.env.DATABASE_URL = databaseUrl
    resetConfig()
    vi.restoreAllMocks()
  })

  it('writes one structured info line with the counts', () => {
    process.env.LOG_LEVEL = 'info'
    resetConfig()
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    logRepair(report, 990_000)
    expect(info).toHaveBeenCalledTimes(1)
    expect(JSON.parse(String(info.mock.calls[0]?.[0]))).toMatchObject({ level: 30, msg: 'release repair finished', durationMs: 990_000, artistCopies: 139, twinsMerged: 20 })
  })

  it('stays quiet above info', () => {
    process.env.LOG_LEVEL = 'warn'
    resetConfig()
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    logRepair(report, 1)
    expect(info).not.toHaveBeenCalled()
  })
})
