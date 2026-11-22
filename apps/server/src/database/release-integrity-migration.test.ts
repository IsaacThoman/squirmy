import { readFile } from 'node:fs/promises'
import { eq, inArray, sql } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { newId } from '../lib/ids.js'
import { creditKey, matchKey } from '../lib/text.js'
import { useTestDatabase } from '../test/database.js'
import { createAlbum, createArtist } from '../test/factories.js'
import { db } from './client.js'
import { albums, recordings } from './schema.js'

/**
 * Migration 0017 on an install with history: the test database is already migrated, so the
 * backfill is replayed from the migration file against rows written the old way.
 */
describe('migration 0017_release_integrity', () => {
  useTestDatabase()

  it('marks the types of album rows that only defaulted to "album" as guesses, and points old hints at the winners', async () => {
    const artist = await createArtist({ name: 'Tate McRae', mbid: crypto.randomUUID() })
    const stub = async (title: string, type: string, mbid: string | null = null) => {
      const id = newId()
      await db.insert(albums).values({ id, mbid, title, artistCredit: artist.name, primaryArtistId: artist.id, type, titleKey: matchKey(title), matchKey: creditKey(artist.name, title) })
      return id
    }
    // A song's album reference, stored as an album before the column existed.
    const exes = await stub('exes', 'album')
    // A typed Deezer stub, a release group, and an album the user has files of keep their types.
    const single = await stub('Sports car', 'single')
    const group = await stub('THINK LATER', 'album', crypto.randomUUID())
    const owned = await createAlbum({ title: 'Owned', artist, owned: true })
    // A song hinted at a stub that an older merge folded into a release group.
    const merged = await stub('THINK LATER', 'album')
    await db.update(albums).set({ mergedIntoId: group }).where(eq(albums.id, merged))
    await db.update(recordings).set({ albumHintId: merged }).where(eq(recordings.id, owned.tracks[0]!.recordingId))

    const file = await readFile(new URL('../../drizzle/0017_release_integrity.sql', import.meta.url), 'utf8')
    const statements = file.split('--> statement-breakpoint')
    expect(statements).toHaveLength(3)
    for (const statement of statements.slice(1)) await db.execute(sql.raw(statement))

    const rows = await db.select({ id: albums.id, typeGuessed: albums.typeGuessed }).from(albums).where(inArray(albums.id, [exes, single, group, owned.albumId]))
    expect(Object.fromEntries(rows.map((row) => [row.id, row.typeGuessed]))).toEqual({ [exes]: true, [single]: false, [group]: false, [owned.albumId]: false })
    const [hinted] = await db.select({ hint: recordings.albumHintId }).from(recordings).where(eq(recordings.id, owned.tracks[0]!.recordingId))
    expect(hinted!.hint).toBe(group)
  })
})
