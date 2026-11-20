import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { parseFile } from 'music-metadata'
import { afterAll, describe, expect, it } from 'vitest'
import { makeAlbum } from './audio.js'
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
      tracks: [{ title: 'Night Swimming', durationSec: 1 }, { title: 'Soft Signal', durationSec: 1 }],
    })
    expect(files).toHaveLength(2)
    expect((await stat(files[0]!)).size).toBeGreaterThan(1000)
    const metadata = await parseFile(files[1]!)
    expect(metadata.common.title).toBe('Soft Signal')
    expect(metadata.common.album).toBe('Blue Hour')
    expect(metadata.common.albumartist).toBe('Mira Vale')
    expect(metadata.common.track.no).toBe(2)
    expect(metadata.common.picture?.length).toBe(1)
  })

  it('creates catalog rows and files', async () => {
    const album = await createAlbum({ owned: [0, 2] })
    expect(await db.select().from(releaseTracks)).toHaveLength(3)
    expect(await db.select().from(mediaFiles)).toHaveLength(2)
    expect(album.tracks[1]?.fileId).toBeNull()
  })
})
