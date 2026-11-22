import { readFile } from 'node:fs/promises'
import { sql } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { newId } from '../lib/ids.js'
import { mergeAlbum } from '../modules/matching/merge.js'
import { useTestDatabase } from '../test/database.js'
import { createAlbum, createUser } from '../test/factories.js'
import { db } from './client.js'
import { acquisitionJobs, acquisitionProviders, likes, mediaFiles } from './schema.js'

/** The statements of a migration file. */
async function statements(name: string): Promise<string[]> {
  const file = await readFile(new URL(`../../drizzle/${name}.sql`, import.meta.url), 'utf8')
  return file.split('--> statement-breakpoint')
}

/** `library_items` as migration 0011 created it; 0018 folded it into `likes` and dropped it. */
async function createOldSaves() {
  await db.execute(sql`create table if not exists library_items (
    user_id uuid not null references users(id) on delete cascade, entity_type text not null, entity_id uuid not null,
    created_at timestamptz not null default now(), primary key (user_id, entity_type, entity_id))`)
}

type SaveRow = { user_id: string; entity_type: string; entity_id: string; created_at: string }
const oldSaves = async () => (await db.execute<SaveRow>(sql`select user_id, entity_type, entity_id, created_at::text from library_items`))
  .map((row) => ({ userId: row.user_id, entityType: row.entity_type, entityId: row.entity_id, createdAt: new Date(row.created_at) }))

/**
 * Migration 0011 on an install with history: the test database is already migrated, so
 * the data step is replayed from the migration file against rows written the old way.
 */
describe('migration 0011_library_membership', () => {
  useTestDatabase()

  async function dataStep() {
    const statement = (await statements('0011_library_membership')).find((part) => part.includes('INSERT INTO "library_items"'))
    expect(statement).toBeDefined()
    await createOldSaves()
    await db.execute(sql.raw(statement!))
  }

  it('turns completed album fetches into saves of their requester, and nothing else', async () => {
    const [fan, member] = [await createUser(), await createUser()]
    const [provider] = await db.insert(acquisitionProviders).values({ id: newId(), name: 'Old', baseUrl: 'http://provider.invalid', secretEncrypted: 'x' }).returning()
    const tracks = (count: number) => Array.from({ length: count }, (_, index) => ({ title: `Track ${index + 1}` }))
    const [fetchedAlbum, playedAlbum, failedAlbum, orphanAlbum, mergedAlbum, survivor, byTrack, playedAhead] = [
      await createAlbum({ owned: true, source: `provider:${provider!.id}` }),
      await createAlbum({ owned: [0], source: `provider:${provider!.id}` }),
      await createAlbum(), await createAlbum(), await createAlbum(), await createAlbum(),
      await createAlbum({ tracks: tracks(8) }), await createAlbum({ tracks: tracks(9) }),
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
        requestedBy: member.id, albumId: byTrack.albumId, recordingId: track.recordingId, createdAt: new Date(burst.getTime() + index * 90),
        completedAt: seconds(burst, 30 + index), status: index === 7 ? 'failed' : 'completed',
      })),
      // Playing through an album: six at once (the current track and five ahead), then one per track.
      ...playedAhead.tracks.map((track, index) => job({
        requestedBy: member.id, albumId: playedAhead.albumId, recordingId: track.recordingId, createdAt: seconds(burst, index < 6 ? 0 : 180 * index),
      })),
    ])
    // A save that already exists is left as it is.
    await createOldSaves()
    await db.execute(sql`insert into library_items (user_id, entity_type, entity_id, created_at) values (${member.id}, 'album', ${survivor.albumId}, '2026-01-01T00:00:00Z')`)

    await dataStep()
    await dataStep()

    const rows = await oldSaves()
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

/**
 * Migration 0018 on an install with both stores: the old table is put back with rows written
 * the old way, and the whole migration is replayed, twice, as a rerun would.
 */
describe('migration 0018_single_heart', () => {
  useTestDatabase()

  it('unions saves into likes, keeping the earlier time, and can run again', async () => {
    const [fan, member] = [await createUser(), await createUser()]
    const [album, both, track] = [await createAlbum(), await createAlbum(), await createAlbum()]
    const recording = track.tracks[0]!.recordingId
    const at = (iso: string) => new Date(iso)
    await createOldSaves()
    await db.execute(sql`insert into library_items (user_id, entity_type, entity_id, created_at) values
      (${fan.id}, 'album', ${album.albumId}, '2026-02-01T00:00:00Z'),
      (${fan.id}, 'album', ${both.albumId}, '2026-01-01T00:00:00Z'),
      (${member.id}, 'album', ${both.albumId}, '2026-05-01T00:00:00Z'),
      (${fan.id}, 'recording', ${recording}, '2026-03-01T00:00:00Z')`)
    await db.insert(likes).values([
      // Liked first, saved later: the like's time stays.
      { userId: member.id, entityType: 'album', entityId: both.albumId, createdAt: at('2026-04-01T00:00:00Z') },
      // Saved first, liked later: the save's time wins.
      { userId: fan.id, entityType: 'album', entityId: both.albumId, createdAt: at('2026-06-01T00:00:00Z') },
      // A like alone stays a save.
      { userId: member.id, entityType: 'artist', entityId: album.artist.id, createdAt: at('2026-07-01T00:00:00Z') },
    ])

    for (let run = 0; run < 2; run++) {
      for (const statement of await statements('0018_single_heart')) await db.execute(sql.raw(statement))
    }

    const rows = await db.select().from(likes)
    expect(rows.map((row) => [row.userId, row.entityType, row.entityId, row.createdAt.toISOString()]).sort()).toEqual([
      [fan.id, 'album', album.albumId, '2026-02-01T00:00:00.000Z'],
      [fan.id, 'album', both.albumId, '2026-01-01T00:00:00.000Z'],
      [fan.id, 'recording', recording, '2026-03-01T00:00:00.000Z'],
      [member.id, 'album', both.albumId, '2026-04-01T00:00:00.000Z'],
      [member.id, 'artist', album.artist.id, '2026-07-01T00:00:00.000Z'],
    ].sort())
    const [table] = await db.execute<{ name: string | null }>(sql`select to_regclass('public.library_items')::text as name`)
    expect(table!.name).toBeNull()
  })
})
