import { readFile } from 'node:fs/promises'
import { eq, sql } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { newId } from '../lib/ids.js'
import { creditKey, matchKey } from '../lib/text.js'
import { useTestDatabase } from '../test/database.js'
import { createArtist } from '../test/factories.js'
import { db } from './client.js'
import { albums, artists } from './schema.js'

/**
 * Migration 0018 on an install with history: the test database is already migrated, so the
 * data fixes are replayed from the migration file against rows written the old way.
 */
describe('migration 0018_artist_read_model', () => {
  useTestDatabase()

  it('files remix albums and DJ mixes as compilations and cleans the separators out of bios', async () => {
    const artist = await createArtist({ name: 'Grimes', mbid: crypto.randomUUID() })
    const album = async (title: string, secondaryTypes: string[], mbid: string | null = crypto.randomUUID()) => {
      const id = newId()
      await db.insert(albums).values({ id, mbid, title, artistCredit: artist.name, primaryArtistId: artist.id, type: 'album', secondaryTypes, titleKey: matchKey(title), matchKey: creditKey(artist.name, title) })
      return id
    }
    const remixes = await album('Miss Anthropocene (Rave Edition)', ['Remix'])
    const mix = await album('DJ-Kicks', ['DJ-mix'])
    const mixtape = await album('Mixtape', ['Mixtape/Street'])
    const studio = await album('Visions', [])
    await db.update(artists).set({ bioSource: 'wikipedia', bio: "The members are Thom Yorke ; brothers Jonny Greenwood (guitar); Ed O'Brien ; and Philip Selway ( ; drums)." }).where(eq(artists.id, artist.id))
    const clean = await createArtist({ name: 'Clean' })
    await db.update(artists).set({ bioSource: 'wikipedia', bio: 'Already tidy (really); fine.' }).where(eq(artists.id, clean.id))

    const file = await readFile(new URL('../../drizzle/0018_artist_read_model.sql', import.meta.url), 'utf8')
    const statements = file.split('--> statement-breakpoint')
    const data = statements.slice(-2)
    // Twice, since a migration's data fix must be idempotent.
    for (let run = 0; run < 2; run++) for (const statement of data) await db.execute(sql.raw(statement))

    const types = Object.fromEntries((await db.select({ id: albums.id, type: albums.type }).from(albums)).map((row) => [row.id, row.type]))
    expect([types[remixes], types[mix], types[mixtape], types[studio]]).toEqual(['compilation', 'compilation', 'album', 'album'])
    const [bio] = await db.select({ bio: artists.bio }).from(artists).where(eq(artists.id, artist.id))
    expect(bio!.bio).toBe("The members are Thom Yorke; brothers Jonny Greenwood (guitar); Ed O'Brien; and Philip Selway (drums).")
    const [tidy] = await db.select({ bio: artists.bio }).from(artists).where(eq(artists.id, clean.id))
    expect(tidy!.bio).toBe('Already tidy (really); fine.')
  })
})
