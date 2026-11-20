import { describe, expect, it } from 'vitest'
import { updateServerSettings } from '../../lib/settings.js'
import { useTestDatabase } from '../../test/database.js'
import { useHttpFixtures } from '../../test/http.js'
import { getLyrics } from './lrclib.js'

describe('lrclib', () => {
  useTestDatabase()
  const http = useHttpFixtures('lrclib')

  it('returns synced and plain lyrics from an exact match', async () => {
    const lyrics = await getLyrics({ title: 'Karma Police', artist: 'Radiohead', album: 'OK Computer', durationMs: 264_000 })
    expect(lyrics!.instrumental).toBe(false)
    expect(lyrics!.synced).toMatch(/^\[\d\d:\d\d\.\d\d\]Karma police$/m)
    expect(lyrics!.plain).toContain('Karma police')
    expect(http.requests).toHaveLength(1)
  })

  it('falls back to search within the duration tolerance', async () => {
    const lyrics = await getLyrics({ title: 'Karma Police', artist: 'Radiohead', album: 'Squirmy Test Album', durationMs: 263_400 })
    expect(lyrics!.synced).toMatch(/\[\d\d:\d\d\.\d\d\]/)
    expect(http.requests.map((request) => new URL(request.split(' ')[1]!).pathname)).toEqual(['/api/get', '/api/search'])
  })

  it('reports instrumentals without lyrics', async () => {
    expect(await getLyrics({ title: 'Treefingers', artist: 'Radiohead', album: 'Kid A', durationMs: 222_600 }))
      .toEqual({ synced: null, plain: null, instrumental: true })
  })

  it('returns null when nothing matches', async () => {
    expect(await getLyrics({ title: 'Quiet Test Tone', artist: 'Squirmy Fixture Band', durationMs: 2_000 })).toBeNull()
    // Search hits whose duration is far off do not count.
    expect(await getLyrics({ title: 'Karma Police', artist: 'Radiohead', album: 'Squirmy Test Album', durationMs: 400_000 })).toBeNull()
  })

  it('returns null without a request when switched off', async () => {
    await updateServerSettings({ lrclibEnabled: false })
    expect(await getLyrics({ title: 'Karma Police', artist: 'Radiohead', durationMs: 264_000 })).toBeNull()
    expect(http.requests).toEqual([])
    await updateServerSettings({ lrclibEnabled: true })
  })
})
