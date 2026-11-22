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
    const [fetchedAlbum, playedAlbum, failedAlbum, orphanAlbum, mergedAlbum, survivor] = [
      await createAlbum({ owned: true, source: `provider:${provider!.id}` }),
      await createAlbum({ owned: [0], source: `provider:${provider!.id}` }),
      await createAlbum(), await createAlbum(), await createAlbum(), await createAlbum(),
    ]
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
    ])
    // A save that already exists is left as it is.
    await db.insert(libraryItems).values({ userId: member.id, entityType: 'album', entityId: survivor.albumId, createdAt: new Date('2026-01-01T00:00:00Z') })

    await dataStep()
    await dataStep()

    const rows = await db.select().from(libraryItems)
    expect(rows.map((row) => [row.userId, row.entityType, row.entityId, row.createdAt.toISOString()]).sort()).toEqual([
      [fan.id, 'album', fetchedAlbum.albumId, completedAt.toISOString()],
      [member.id, 'album', survivor.albumId, '2026-01-01T00:00:00.000Z'],
    ].sort())
    // Every delivered file is cache now, generated from its source.
    const files = await db.select({ source: mediaFiles.source, cached: mediaFiles.cached }).from(mediaFiles)
    expect(files.length).toBeGreaterThan(0)
    expect(files.every((file) => file.cached)).toBe(true)
  })
})
