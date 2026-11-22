import { readFile } from 'node:fs/promises'
import { sql } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { newId } from '../lib/ids.js'
import { mergeAlbum } from '../modules/matching/merge.js'
import { useTestDatabase } from '../test/database.js'
import { createAlbum, createUser } from '../test/factories.js'
import { db } from './client.js'
import { acquisitionJobs, acquisitionProviders, libraryItems, mediaFiles } from './schema.js'

/**
 * Migration 0011 on an install with history: the test database is already migrated, so
 * the data step is replayed from the migration file against rows written the old way.
 */
describe('migration 0011_library_membership', () => {
  useTestDatabase()

  async function dataStep() {
    const file = await readFile(new URL('../../drizzle/0011_library_membership.sql', import.meta.url), 'utf8')
    const statement = file.split('--> statement-breakpoint').find((part) => part.includes('INSERT INTO "library_items"'))
    expect(statement).toBeDefined()
    await db.execute(sql.raw(statement!))
  }

  it('turns completed album fetches into saves of their requester, and nothing else', async () => {
    const [fan, member] = [await createUser(), await createUser()]
    const [provider] = await db.insert(acquisitionProviders).values({ id: newId(), name: 'Old', baseUrl: 'http://provider.invalid', secretEncrypted: 'x' }).returning()
    const fiveTracks = Array.from({ length: 5 }, (_, index) => ({ title: `Track ${index + 1}` }))
    const [fetchedAlbum, playedAlbum, failedAlbum, orphanAlbum, mergedAlbum, survivor, byTrack, playedAhead] = [
      await createAlbum({ owned: true, source: `provider:${provider!.id}` }),
      await createAlbum({ owned: [0], source: `provider:${provider!.id}` }),
      await createAlbum(), await createAlbum(), await createAlbum(), await createAlbum(),
      await createAlbum({ tracks: fiveTracks }), await createAlbum({ tracks: fiveTracks }),
    ]
    const burst = new Date('2026-03-01T11:00:00Z')
    const seconds = (from: Date, n: number) => new Date(from.getTime() + n * 1000)
    await mergeAlbum(mergedAlbum.albumId, survivor.albumId)
    const completedAt = new Date('2026-03-01T12:00:00Z')
    const job = (input: Partial<typeof acquisitionJobs.$inferInsert>) => ({
      id: newId(), providerId: provider!.id, status: 'completed', completedAt, idempotencyKey: newId(), ...input,
    })
    await db.insert(acquisitionJobs).values([
      job({ requestedBy: fan.id, albumId: fetchedAlbum.albumId }),
      // The same album fetched twice keeps the first time.
      job({ requestedBy: fan.id, albumId: fetchedAlbum.albumId, completedAt: new Date('2026-04-01T00:00:00Z') }),
      // Pressing play fetched one recording; that is no add.
      job({ requestedBy: fan.id, albumId: playedAlbum.albumId, recordingId: playedAlbum.tracks[0]!.recordingId }),
      job({ requestedBy: member.id, albumId: failedAlbum.albumId, status: 'failed' }),
      job({ requestedBy: null, albumId: orphanAlbum.albumId }),
      job({ requestedBy: member.id, albumId: mergedAlbum.albumId }),
      // "Get this album" with a track-only provider: every missing track at once.
      ...byTrack.tracks.map((track, index) => job({
        requestedBy: member.id, albumId: byTrack.albumId, recordingId: track.recordingId, createdAt: seconds(burst, index % 2),
        completedAt: seconds(burst, 30 + index), status: index === 4 ? 'failed' : 'completed',
      })),
      // Playing through an album: three at a time, never four within seconds.
      ...playedAhead.tracks.map((track, index) => job({
        requestedBy: member.id, albumId: playedAhead.albumId, recordingId: track.recordingId, createdAt: seconds(burst, index < 3 ? 0 : 180 * index),
      })),
    ])
    // A save that already exists is left as it is.
    await db.insert(libraryItems).values({ userId: member.id, entityType: 'album', entityId: survivor.albumId, createdAt: new Date('2026-01-01T00:00:00Z') })

    await dataStep()
    await dataStep()

    const rows = await db.select().from(libraryItems)
    expect(rows.map((row) => [row.userId, row.entityType, row.entityId, row.createdAt.toISOString()]).sort()).toEqual([
      [fan.id, 'album', fetchedAlbum.albumId, completedAt.toISOString()],
      [member.id, 'album', survivor.albumId, '2026-01-01T00:00:00.000Z'],
      [member.id, 'album', byTrack.albumId, seconds(burst, 30).toISOString()],
    ].sort())
    // Every delivered file is cache now, generated from its source.
    const files = await db.select({ source: mediaFiles.source, cached: mediaFiles.cached }).from(mediaFiles)
    expect(files.length).toBeGreaterThan(0)
    expect(files.every((file) => file.cached)).toBe(true)
  })
})
