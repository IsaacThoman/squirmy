import { eq, sql } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { db } from '../../database/client.js'
import { albumArtists, albums, artists, externalIds } from '../../database/schema.js'
import { newId } from '../../lib/ids.js'
import { creditKey, matchKey } from '../../lib/text.js'
import { useTestDatabase } from '../../test/database.js'
import { materialize } from './materialize.js'
import type { ProviderAlbum } from './providers.js'

async function artistWithAlbum(name: string, deezerId: string, albumTitle: string, mbid: string | null = null) {
  const id = newId()
  await db.insert(artists).values({ id, name, sortName: name, nameKey: matchKey(name), mbid, detailLevel: 2 })
  await db.insert(externalIds).values({ provider: 'deezer', entityType: 'artist', externalId: deezerId, entityId: id })
  const albumId = newId()
  await db.insert(albums).values({ id: albumId, title: albumTitle, artistCredit: name, primaryArtistId: id, titleKey: matchKey(albumTitle), matchKey: creditKey(name, albumTitle) })
  await db.insert(albumArtists).values({ albumId, position: 0, artistId: id, creditedName: name })
  return id
}

const deezerAlbum = (id: string, title: string, artist: { id: string; name: string }): ProviderAlbum => ({
  id, mbid: null, title, artistCredit: artist.name, artists: [{ id: artist.id, mbid: null, name: artist.name, joinPhrase: '' }],
  type: 'album', year: null, releaseDate: null, artworkUrl: null,
})

const rowsNamed = (name: string) => db.select({ id: artists.id }).from(artists).where(eq(artists.nameKey, matchKey(name)))

describe('artists in catalog search results', () => {
  useTestDatabase()

  it('takes a second Deezer page of an artist for the artist it is, by what the response credits it with', async () => {
    // Grimes on the test instance: Deezer's 807493 and 285342121 are one artist.
    const grimes = await artistWithAlbum('Grimes', '807493', 'Halfaxa', '7e5a2a59-6d9f-4a17-b7c2-e1eedb7bd222')
    const second = { id: '285342121', name: 'Grimes' }
    const ids = await materialize('deezer', { artists: [{ ...second, mbid: null, imageUrl: null }], albums: [deezerAlbum('565821871', 'Halfaxa', second)], tracks: [] })
    expect(ids.artists).toEqual([grimes])
    expect(await rowsNamed('Grimes')).toHaveLength(1)
    const [linked] = await db.select({ entityId: externalIds.entityId }).from(externalIds).where(eq(externalIds.externalId, '285342121'))
    expect(linked!.entityId).toBe(grimes)
  })

  it('keeps a namesake apart: nothing in common', async () => {
    const adele = await artistWithAlbum('Adele', '75798', '21')
    const other = { id: '5673798', name: 'Adele' }
    const ids = await materialize('deezer', { artists: [{ ...other, mbid: null, imageUrl: null }], albums: [deezerAlbum('9000001', 'Canções de Ninar', other)], tracks: [] })
    expect(ids.artists).not.toContain(adele)
    expect(await rowsNamed('Adele')).toHaveLength(2)
    const [row] = await db.execute<{ count: number }>(sql`select count(*)::int as count from external_ids where external_id = '5673798' and entity_id = ${adele}`)
    expect(row!.count).toBe(0)
  })
})
