import { readFile } from 'node:fs/promises'
import { eq, sql } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { newId } from '../lib/ids.js'
import { useTestDatabase } from '../test/database.js'
import { createAlbum, createLibraryRoot } from '../test/factories.js'
import { db } from './client.js'
import { acquisitionJobs, acquisitionProviders, matchReviews, mediaFiles } from './schema.js'

/**
 * Migration 0013 on an install with history: the test database is already migrated, so the
 * data statements are replayed from the migration file against rows written the old way.
 */
describe('migration 0013_provider_cache', () => {
  useTestDatabase()

  async function dataSteps() {
    const file = await readFile(new URL('../../drizzle/0013_provider_cache.sql', import.meta.url), 'utf8')
    const statements = file.split('--> statement-breakpoint').filter((part) => /^\s*(--[^\n]*\n\s*)*UPDATE/.test(part))
    expect(statements).toHaveLength(2)
    for (const statement of statements) await db.execute(sql.raw(statement))
  }

  it('marks album jobs as library requests and closes reviews that listening opened, nothing else', async () => {
    const [provider] = await db.insert(acquisitionProviders).values({ id: newId(), name: 'Old', baseUrl: 'http://provider.invalid', secretEncrypted: 'x' }).returning()
    const album = await createAlbum()
    const job = (input: Partial<typeof acquisitionJobs.$inferInsert>) => ({ id: newId(), providerId: provider!.id, status: 'completed', idempotencyKey: newId(), ...input })
    const [albumJob, trackJob] = [job({ albumId: album.albumId }), job({ albumId: album.albumId, recordingId: album.tracks[0]!.recordingId })]
    await db.insert(acquisitionJobs).values([albumJob, trackJob])

    const root = await createLibraryRoot({ mode: 'managed' })
    const group = async (sources: string[]) => {
      const groupKey = newId()
      const made = await createAlbum({ rootId: root.id, owned: true, tracks: sources.map((_, index) => ({ title: `T${index}` })) })
      for (const [index, source] of sources.entries()) {
        await db.update(mediaFiles).set({ source, groupKey }).where(eq(mediaFiles.id, made.tracks[index]!.fileId!))
      }
      const [review] = await db.insert(matchReviews).values({ id: newId(), rootId: root.id, groupKey, summary: {} }).returning()
      return review!.id
    }
    const listened = await group([`provider:${provider!.id}`, `provider:${provider!.id}`])
    const mixed = await group([`provider:${provider!.id}`, 'scan'])
    const brought = await group(['upload'])
    const empty = (await db.insert(matchReviews).values({ id: newId(), rootId: root.id, groupKey: 'gone', summary: {} }).returning())[0]!.id

    await dataSteps()
    const origin = async (id: string) => (await db.select({ origin: acquisitionJobs.origin }).from(acquisitionJobs).where(eq(acquisitionJobs.id, id)))[0]!.origin
    expect([await origin(albumJob.id), await origin(trackJob.id)]).toEqual(['library', 'play'])
    const status = async (id: string) => (await db.select({ status: matchReviews.status }).from(matchReviews).where(eq(matchReviews.id, id)))[0]!.status
    expect([await status(listened), await status(mixed), await status(brought), await status(empty)]).toEqual(['dismissed', 'open', 'open', 'open'])
  })
})
