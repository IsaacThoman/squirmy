import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterAll, describe, expect, it } from 'vitest'
import { resetConfig } from '../../config.js'
import { ProviderError } from '../../lib/http.js'
import { updateServerSettings } from '../../lib/settings.js'
import { makeTone, writeHostileInputs } from '../../test/audio.js'
import { useTestDatabase } from '../../test/database.js'
import { useHttpFixtures } from '../../test/http.js'
import { fingerprint, lookup } from './acoustid.js'

const run = promisify(execFile)

/** A made-up fingerprint; the lookup fixtures are hand-written for it. */
const print = 'AQADtEmUaFKSRMmSRIkSJUqUKFGiRIkSJUqUKFGiRIkSJUqUKFGiRIkSJUqUKFGiRIkSJUqUKFGiRIkSJUqUKFGiRIkSJUqUKFGiRIkSJUqUKFGiRIkSJUqUKFGiRIkSJUqUKFGiRIkSJUqUKFGi'

describe('acoustid', () => {
  useTestDatabase()
  const http = useHttpFixtures('acoustid')
  let directory: string | undefined
  afterAll(async () => {
    if (directory) await rm(directory, { recursive: true, force: true })
  })

  it('fingerprints an audio file with fpcalc', async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'squirmy-acoustid-'))
    const file = await makeTone(directory, { path: 'tone.flac', durationSec: 12 })
    const result = await fingerprint(file)
    expect(result!.durationSec).toBe(12)
    expect(result!.fingerprint).toMatch(/^AQA[A-Za-z0-9_-]+$/)
    await expect(fingerprint(path.join(directory, 'missing.flac'))).rejects.toThrow()
  })

  it('matches what fpcalc prints for the file itself', async () => {
    directory ??= await mkdtemp(path.join(tmpdir(), 'squirmy-acoustid-'))
    const file = await makeTone(directory, { path: 'other.mp3', durationSec: 8, frequency: 523 })
    const { stdout } = await run('fpcalc', ['-json', file])
    expect((await fingerprint(file))!.fingerprint).toBe((JSON.parse(stdout) as { fingerprint: string }).fingerprint)
  })

  it('refuses a file whose content makes the decoder read another file', async () => {
    directory ??= await mkdtemp(path.join(tmpdir(), 'squirmy-acoustid-'))
    await makeTone(directory, { path: 'hostile/real.flac', durationSec: 12 })
    const files = await writeHostileInputs(path.join(directory, 'hostile'), { target: 'real.flac', url: 'http://127.0.0.1:9' })
    for (const file of [files.concat, files.sdp]) await expect(fingerprint(file)).rejects.toThrow()
  })

  it('returns null when fpcalc is not installed', async () => {
    const previous = process.env.FPCALC_PATH
    process.env.FPCALC_PATH = '/nonexistent/fpcalc'
    resetConfig()
    try {
      directory ??= await mkdtemp(path.join(tmpdir(), 'squirmy-acoustid-'))
      expect(await fingerprint(await makeTone(directory, { path: 'present.flac', durationSec: 1 }))).toBeNull()
    } finally {
      if (previous === undefined) delete process.env.FPCALC_PATH
      else process.env.FPCALC_PATH = previous
      resetConfig()
    }
  })

  it('looks nothing up without an API key', async () => {
    expect(await lookup(print, 236)).toEqual([])
    expect(http.requests).toEqual([])
  })

  it('ranks matching recordings, one entry each', async () => {
    await updateServerSettings({ acoustIdKey: 'test-acoustid-key' })
    expect(await lookup(print, 236)).toEqual([
      { recordingMbid: '33b6b148-9dce-4894-902d-d218ecc30666', score: 0.97, acoustId: 'a6c3e3b2-2f07-4d1b-9ac4-3f0c6ad4e2a1', title: 'Uptown Funk', artistName: 'Mark Ronson feat. Bruno Mars', durationMs: 270_000 },
      { recordingMbid: 'c3a25100-952c-44cc-a3f5-2d2ecdb5892b', score: 0.42, acoustId: '0d8f5f0e-7c32-4c4a-8f0b-7b1d3a8d6c55', title: 'Uptown Funk (BB Disco dub)', artistName: 'Mark Ronson', durationMs: 335_000 },
    ])
  })

  it('throws on an invalid key', async () => {
    await updateServerSettings({ acoustIdKey: 'revoked-acoustid-key' })
    const failure = lookup(print, 236)
    await expect(failure).rejects.toBeInstanceOf(ProviderError)
    await expect(failure).rejects.toMatchObject({ upstreamCode: 4 })
  })
})
