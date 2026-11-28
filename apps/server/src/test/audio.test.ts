import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { parseFile } from 'music-metadata'
import { afterAll, describe, expect, it } from 'vitest'
import { makeAlbum, makeTone } from './audio.js'
import { createAlbum } from './factories.js'
import { useTestDatabase } from './database.js'
import { db } from '../database/client.js'
import { mediaFiles, releaseTracks } from '../database/schema.js'

describe('test fixtures', () => {
  useTestDatabase()
  const directories: string[] = []
  afterAll(async () => { for (const directory of directories) await rm(directory, { recursive: true, force: true }) })

  it('generates a tagged album of quiet tones', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'squirmy-audio-'))
    directories.push(root)
    const files = await makeAlbum(root, {
      artist: 'Mira Vale', album: 'Blue Hour', year: 2025, cover: true,
      tracks: [{ title: 'Night Swimming', durationSec: 1 }, { title: 'Soft Signal', durationSec: 3 }],
    })
    expect(files).toHaveLength(2)
    expect((await stat(files[0]!)).size).toBeGreaterThan(1000)
    const metadata = await parseFile(files[1]!)
    expect(metadata.common.title).toBe('Soft Signal')
    expect(metadata.common.album).toBe('Blue Hour')
    expect(metadata.common.albumartist).toBe('Mira Vale')
    expect(metadata.common.track.no).toBe(2)
    expect(metadata.common.picture?.length).toBe(1)
    expect(metadata.format.duration).toBeCloseTo(3, 1)
  })

  it('writes every supported format at the requested length', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'squirmy-audio-'))
    directories.push(root)
    for (const format of ['flac', 'mp3', 'm4a', 'ogg', 'opus', 'wav'] as const) {
      const file = await makeTone(root, { path: `tone.${format}`, durationSec: 2, cover: true, tags: { title: format } })
      const metadata = await parseFile(file)
      expect(metadata.format.duration, format).toBeGreaterThan(1.9)
      expect(metadata.format.duration, format).toBeLessThan(2.2)
    }
  })

  it('writes hi-res lossless tones at the requested rate and depth', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'squirmy-audio-'))
    directories.push(root)
    for (const format of ['flac', 'wav'] as const) {
      const file = await makeTone(root, { path: `hires.${format}`, durationSec: 1, sampleRate: 96_000, bitDepth: 24 })
      const { format: probed } = await parseFile(file)
      expect([probed.sampleRate, probed.bitsPerSample], format).toEqual([96_000, 24])
    }
    const cd = await parseFile(await makeTone(root, { path: 'cd.flac', durationSec: 1, bitDepth: 16 }))
    expect([cd.format.sampleRate, cd.format.bitsPerSample]).toEqual([44_100, 16])
    await expect(makeTone(root, { path: 'deep.mp3', bitDepth: 24 })).rejects.toThrow('no bit depth')
  })

  it('creates catalog rows and files', async () => {
    const album = await createAlbum({ owned: [0, 2] })
    expect(await db.select().from(releaseTracks)).toHaveLength(3)
    expect(await db.select().from(mediaFiles)).toHaveLength(2)
    expect(album.tracks[1]?.fileId).toBeNull()
  })
})
