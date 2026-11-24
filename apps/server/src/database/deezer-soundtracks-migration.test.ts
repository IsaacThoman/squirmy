import { readFile } from 'node:fs/promises'
import { eq, sql } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { SOUNDTRACK_TITLE } from '../modules/metadata/deezer.js'
import { useTestDatabase } from '../test/database.js'
import { createAlbum, createArtist } from '../test/factories.js'
import { db } from './client.js'
import { albums, externalIds } from './schema.js'

/**
 * Migration 0023 on an install with history: the test database is already migrated, so the
 * fix is replayed from the migration file against rows written the old way.
 */
describe('migration 0023_deezer_soundtracks', () => {
  useTestDatabase()

  const replay = async () => {
    const file = await readFile(new URL('../../drizzle/0023_deezer_soundtracks.sql', import.meta.url), 'utf8')
    // Twice, since a migration's data fix must be idempotent.
    for (let run = 0; run < 2; run++) for (const statement of file.split('--> statement-breakpoint')) await db.execute(sql.raw(statement))
  }
  let deezerId = 1000
  /** An album row as the Deezer discography wrote it: no MusicBrainz id, Deezer's album type. */
  const deezerAlbum = async (title: string, options: { genres?: string[]; mbid?: string; deezer?: boolean } = {}) => {
    const artist = await createArtist({ name: 'Hans Zimmer' })
    const { albumId } = await createAlbum({ artist, title, mbid: options.mbid })
    if (options.genres) await db.update(albums).set({ genres: options.genres }).where(eq(albums.id, albumId))
    if (options.deezer !== false) await db.insert(externalIds).values({ provider: 'deezer', entityType: 'album', externalId: String(deezerId++), entityId: albumId })
    return albumId
  }
  const typeOf = async (id: string) => (await db.select({ type: albums.type }).from(albums).where(eq(albums.id, id)))[0]!.type

  it('types as soundtracks the Deezer-only albums whose title or genres say they are', async () => {
    const titled = await deezerAlbum('The Dark Knight (Original Motion Picture Soundtrack) [Deluxe Edition]')
    const scored = await deezerAlbum('Dune: Part Two (Original Score)')
    const filed = await deezerAlbum('Gladiator: 20th Anniversary Edition', { genres: ['Films/Games'] })
    // Not a film's words, and no genre yet: the release repair reads it from Deezer.
    const unread = await deezerAlbum('More Music From Gladiator')
    const album = await deezerAlbum('Soundtrack to My Life', { genres: ['Rap/Hip Hop'] })
    // MusicBrainz's type wins; and a row Deezer did not write is not Deezer's to type.
    const musicBrainz = await deezerAlbum('Inception (Music from the Motion Picture)', { mbid: '6a1c6fa0-4a0f-4cc8-9b6e-46cb6b0f7a6e' })
    const tagged = await deezerAlbum('Tenet (Original Motion Picture Soundtrack)', { deezer: false })
    await replay()
    expect(await Promise.all([titled, scored, filed, unread, album, musicBrainz, tagged].map(typeOf)))
      .toEqual(['soundtrack', 'soundtrack', 'soundtrack', 'album', 'album', 'album', 'album'])
  })

  it('matches titles as deezer.ts does', async () => {
    const titles = [
      'Interstellar (Original Motion Picture Soundtrack)', 'Cyberpunk 2077 (Original Video Game Soundtrack)', 'The Lion King (Music from the Motion Picture)',
      'Dune (Original Score)', 'Soundtrack to My Life', 'The Score', 'Original Pirate Material', 'Music From Gladiator',
    ]
    const pattern = await sqlPattern()
    const matches = []
    for (const title of titles) {
      const [row] = await db.execute<{ match: boolean }>(sql`select ${title}::text ~* ${pattern}::text as match`)
      matches.push(row!.match)
    }
    expect(matches).toEqual(titles.map((title) => SOUNDTRACK_TITLE.test(title)))
    expect(matches).toEqual([true, true, true, true, false, false, false, false])
  })

  /** The pattern migration 0023 uses, read from the file. */
  const sqlPattern = async () => {
    const file = await readFile(new URL('../../drizzle/0023_deezer_soundtracks.sql', import.meta.url), 'utf8')
    return /"title" ~\* '([^']+)'/.exec(file)![1]!
  }
})
