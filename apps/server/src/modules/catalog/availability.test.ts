import { eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '../../database/client.js'
import { albums, mediaFiles } from '../../database/schema.js'
import { useTestDatabase } from '../../test/database.js'
import { createAlbum } from '../../test/factories.js'
import { onDemandRecordings } from '../acquisition/coverage.js'
import { albumAvailability, trackAvailability } from './availability.js'

vi.mock('../acquisition/coverage.js', () => ({ onDemandRecordings: vi.fn(async () => new Set<string>()) }))
const coverage = vi.mocked(onDemandRecordings)

describe('availability', () => {
  useTestDatabase()
  beforeEach(() => {
    coverage.mockReset()
    coverage.mockResolvedValue(new Set())
  })

  it('counts owned tracks on the canonical release', async () => {
    const full = await createAlbum({ owned: true })
    const partial = await createAlbum({ owned: [0, 2] })
    const none = await createAlbum()
    const result = await albumAvailability([full.albumId, partial.albumId, none.albumId])
    expect(result.get(full.albumId)).toEqual({ availability: 'full', trackCount: 3, ownedTrackCount: 3 })
    expect(result.get(partial.albumId)).toEqual({ availability: 'partial', trackCount: 3, ownedTrackCount: 2 })
    expect(result.get(none.albumId)).toEqual({ availability: 'none', trackCount: 3, ownedTrackCount: 0 })

    const tracks = await trackAvailability(partial.tracks.map((track) => track.recordingId))
    expect([...tracks.values()]).toEqual(['server', 'none', 'server'])
  })

  it('ignores missing files', async () => {
    const album = await createAlbum({ owned: true })
    await db.update(mediaFiles).set({ missingSince: new Date() }).where(eq(mediaFiles.id, album.tracks[0]!.fileId!))
    expect((await albumAvailability([album.albumId])).get(album.albumId)?.availability).toBe('partial')
    expect((await trackAvailability([album.tracks[0]!.recordingId])).get(album.tracks[0]!.recordingId)).toBe('none')
  })

  it('asks the acquisition seam about unowned recordings only', async () => {
    const owned = await createAlbum({ owned: [0] })
    const unowned = await createAlbum()
    const covered = new Set([...owned.tracks, ...unowned.tracks].map((track) => track.recordingId))
    coverage.mockImplementation(async (ids) => new Set(ids.filter((id) => covered.has(id))))

    const tracks = await trackAvailability(owned.tracks.map((track) => track.recordingId))
    expect([...tracks.values()]).toEqual(['server', 'on_demand', 'on_demand'])
    expect(coverage).toHaveBeenCalledWith([owned.tracks[1]!.recordingId, owned.tracks[2]!.recordingId])

    const result = await albumAvailability([owned.albumId, unowned.albumId])
    expect(result.get(owned.albumId)?.availability).toBe('partial')
    expect(result.get(unowned.albumId)?.availability).toBe('on_demand')

    // An album is on demand only when every one of its tracks is.
    covered.delete(unowned.tracks[1]!.recordingId)
    expect((await albumAvailability([unowned.albumId])).get(unowned.albumId)?.availability).toBe('none')
  })

  it('falls back to the largest release when an album has no canonical release', async () => {
    const album = await createAlbum({ owned: true })
    await db.update(albums).set({ canonicalReleaseId: null }).where(eq(albums.id, album.albumId))
    expect((await albumAvailability([album.albumId])).get(album.albumId)).toEqual({ availability: 'full', trackCount: 3, ownedTrackCount: 3 })
  })

  it('skips the seam and the database for empty input', async () => {
    expect((await trackAvailability([])).size).toBe(0)
    expect((await albumAvailability([])).size).toBe(0)
    expect(coverage).not.toHaveBeenCalled()
  })
})
