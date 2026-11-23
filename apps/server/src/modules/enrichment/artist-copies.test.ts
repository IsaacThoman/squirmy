import { eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it } from 'vitest'
import { db } from '../../database/client.js'
import { albumArtists, albums, artists, externalIds, likes } from '../../database/schema.js'
import { newId } from '../../lib/ids.js'
import { updateServerSettings } from '../../lib/settings.js'
import { creditKey, matchKey } from '../../lib/text.js'
import { useTestDatabase } from '../../test/database.js'
import { createUser } from '../../test/factories.js'
import { useHttpFixtures } from '../../test/http.js'
import { foldArtistCopies, foldArtistCopy } from './artist-copies.js'

async function artist(name: string, deezerId: string, input: { mbid?: string; disambiguation?: string; albums?: string[] } = {}) {
  const id = newId()
  await db.insert(artists).values({ id, name, sortName: name, nameKey: matchKey(name), mbid: input.mbid, disambiguation: input.disambiguation, detailLevel: input.mbid ? 2 : 0 })
  await db.insert(externalIds).values({ provider: 'deezer', entityType: 'artist', externalId: deezerId, entityId: id })
  for (const title of input.albums ?? []) {
    const albumId = newId()
    // A MusicBrainz artist's albums are its release groups.
    await db.insert(albums).values({
      id: albumId, mbid: input.mbid ? crypto.randomUUID() : null, title, artistCredit: name, primaryArtistId: id, titleKey: matchKey(title), matchKey: creditKey(name, title),
    })
    await db.insert(albumArtists).values({ albumId, position: 0, artistId: id, creditedName: name })
  }
  return id
}

const row = async (id: string) => (await db.select().from(artists).where(eq(artists.id, id)))[0]!

/** Pages as Deezer answered them on 2026-11-22. */
describe('second Deezer pages of one artist', () => {
  useTestDatabase()
  useHttpFixtures('deezer')
  beforeEach(() => updateServerSettings({ musicBrainzEnabled: false, deezerEnabled: true }))

  it('merges a second page into the artist when they share releases, keeping the disambiguation and likes', async () => {
    const grimes = await artist('Grimes', '807493', { mbid: '7e5a2a59-6d9f-4a17-b7c2-e1eedb7bd222', disambiguation: 'Canadian musician', albums: ['Visions', 'Art Angels'] })
    // Deezer's second Grimes page lists nothing any more; search credited it with the
    // albums it showed under it, as on the test instance.
    const second = await artist('Grimes', '285342121', { albums: ['Halfaxa', 'Art Angels'] })
    const user = await createUser()
    await db.insert(likes).values({ userId: user.id, entityType: 'artist', entityId: second })

    expect(await foldArtistCopy(second)).toBe(grimes)
    expect(await row(second)).toMatchObject({ mergedIntoId: grimes })
    expect(await row(grimes)).toMatchObject({ disambiguation: 'Canadian musician', mergedIntoId: null })
    const ids = await db.select({ id: externalIds.externalId }).from(externalIds).where(eq(externalIds.entityId, grimes))
    expect(ids.map((one) => one.id).sort()).toEqual(['285342121', '807493'])
    expect(await db.select({ entityId: likes.entityId }).from(likes).where(eq(likes.userId, user.id))).toEqual([{ entityId: grimes }])
  })

  it('compares a MusicBrainz artist by what MusicBrainz credits it with, not by what search credited it with', async () => {
    // Deezer's lo-fi "Genesis" (12515862): search had credited one of its albums to the band
    // by name, which must not make it the band.
    const band = await artist('Genesis', '3037', { mbid: '8e3fcd7d-bda1-4ca0-b987-b8528d2ee74e', albums: ['Selling England by the Pound'] })
    const misCredited = newId()
    await db.insert(albums).values({ id: misCredited, title: 'Soft Glow', artistCredit: 'Genesis', primaryArtistId: band, titleKey: matchKey('Soft Glow'), matchKey: creditKey('Genesis', 'Soft Glow') })
    await db.insert(albumArtists).values({ albumId: misCredited, position: 0, artistId: band, creditedName: 'Genesis' })
    const lofi = await artist('Genesis', '12515862', { albums: ['Soft Glow'] })
    expect(await foldArtistCopy(lofi)).toBeNull()
  })

  it('keeps namesakes apart, and runs again without changing anything', async () => {
    // Deezer's big "Adele" and another singer of that name with one album.
    const adele = await artist('Adele', '75798', { albums: ['21'] })
    const other = await artist('Adele', '5673798')
    expect(await foldArtistCopy(other)).toBeNull()
    expect(await foldArtistCopy(adele)).toBeNull()
    expect(await foldArtistCopies()).toBe(0)
    expect((await row(other)).mergedIntoId).toBeNull()
  })
})
