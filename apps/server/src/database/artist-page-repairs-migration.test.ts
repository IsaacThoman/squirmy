import { readFile } from 'node:fs/promises'
import { eq, sql } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { newId, newPublicId } from '../lib/ids.js'
import { creditKey, matchKey } from '../lib/text.js'
import { useTestDatabase } from '../test/database.js'
import { createArtist } from '../test/factories.js'
import { db } from './client.js'
import { albums, artists, assets } from './schema.js'

/**
 * Migration 0022 on an install with history: the test database is already migrated, so the
 * data fixes are replayed from the migration file against rows written the old way.
 */
describe('migration 0022_artist_page_repairs', () => {
  useTestDatabase()

  const replay = async () => {
    const file = await readFile(new URL('../../drizzle/0022_artist_page_repairs.sql', import.meta.url), 'utf8')
    // Twice, since a migration's data fix must be idempotent.
    for (let run = 0; run < 2; run++) for (const statement of file.split('--> statement-breakpoint')) await db.execute(sql.raw(statement))
  }
  const asset = async (source: string) => {
    const [row] = await db.insert(assets).values({ id: newPublicId(), kind: 'artist', source, remoteUrl: source.startsWith('http') ? source : null, status: 'remote' }).returning()
    return row!.id
  }
  const row = async (id: string) => (await db.select().from(artists).where(eq(artists.id, id)))[0]!

  it('takes the web picture, bio, genres and disambiguation off placeholder artists', async () => {
    const photo = await asset('https://cdn-images.dzcdn.net/images/artist/various/1000x1000.jpg')
    const various = await createArtist({ name: 'Various Artists', mbid: '89ad4ac3-39f7-470e-963a-56509c546377' })
    await db.update(artists).set({
      imageAssetId: photo, bio: 'A compilation album comprises tracks…', bioSource: 'wikipedia', bioUrl: 'https://en.wikipedia.org/wiki/Compilation_album',
      disambiguation: 'add compilations to this artist', genres: ['pop rock'],
    }).where(eq(artists.id, various.id))
    // [unknown], with a picture from the user's folders: that stays.
    const folder = await asset('/music/Unknown/artist.jpg')
    const unknown = await createArtist({ name: '[unknown]', mbid: '125ec42a-7229-4250-afc5-e057484327fe' })
    await db.update(artists).set({ imageAssetId: folder, disambiguation: 'Special Purpose Artist' }).where(eq(artists.id, unknown.id))
    // A real artist keeps everything.
    const band = await createArtist({ name: 'Band', mbid: crypto.randomUUID() })
    await db.update(artists).set({ imageAssetId: photo, bio: 'A band.', disambiguation: 'the band', genres: ['rock'] }).where(eq(artists.id, band.id))

    await replay()

    expect(await row(various.id)).toMatchObject({ imageAssetId: null, bio: null, bioSource: null, bioUrl: null, disambiguation: null, genres: [] })
    expect(await row(unknown.id)).toMatchObject({ imageAssetId: folder, disambiguation: null })
    expect(await row(band.id)).toMatchObject({ imageAssetId: photo, bio: 'A band.', disambiguation: 'the band', genres: ['rock'] })
  })

  it('has artists that lead a MusicBrainz soundtrack fetch their discography again', async () => {
    const fetchedAt = new Date('2026-11-01T00:00:00Z')
    const artist = async (name: string, type: string, mbid: string | null = crypto.randomUUID()) => {
      const created = await createArtist({ name, mbid: crypto.randomUUID() })
      await db.update(artists).set({ detailLevel: 2, fetchedAt }).where(eq(artists.id, created.id))
      await db.insert(albums).values({ id: newId(), mbid, title: `${name} release`, artistCredit: name, primaryArtistId: created.id, type, titleKey: matchKey(`${name} release`), matchKey: creditKey(name, `${name} release`) })
      return created.id
    }
    // A film's single typed soundtrack by older code ("I Knew It, I Knew You").
    const singer = await artist('Singer', 'soundtrack')
    const band = await artist('Band', 'album')
    // Typed by tags, not MusicBrainz: nothing to fetch again.
    const tagged = await artist('Tagged', 'soundtrack', null)

    await replay()

    expect(await row(singer)).toMatchObject({ detailLevel: 1, fetchedAt: null })
    expect(await row(band)).toMatchObject({ detailLevel: 2, fetchedAt })
    expect(await row(tagged)).toMatchObject({ detailLevel: 2, fetchedAt })
  })
})
