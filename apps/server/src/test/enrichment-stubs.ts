import { eq } from 'drizzle-orm'
import { db } from '../database/client.js'
import { albumArtists, albums, artists, externalIds } from '../database/schema.js'
import { newId } from '../lib/ids.js'
import { creditKey, matchKey } from '../lib/text.js'

/** Stub rows as the search module stores catalog results (`detail_level` 0), for enrichment tests. */

export async function artistStub(input: { name: string; mbid?: string; deezerId?: number }) {
  const id = newId()
  await db.insert(artists).values({ id, name: input.name, sortName: input.name, nameKey: matchKey(input.name), mbid: input.mbid, detailLevel: 0 })
  if (input.deezerId) await db.insert(externalIds).values({ provider: 'deezer', entityType: 'artist', externalId: String(input.deezerId), entityId: id })
  return id
}

export async function albumStub(input: { title: string; artist: string; artistId?: string; mbid?: string; deezerId?: number; year?: number }) {
  const artistId = input.artistId ?? await artistStub({ name: input.artist })
  const id = newId()
  await db.insert(albums).values({
    id,
    mbid: input.mbid,
    title: input.title,
    artistCredit: input.artist,
    primaryArtistId: artistId,
    type: 'album',
    year: input.year ?? null,
    releaseDate: input.year ? String(input.year) : null,
    titleKey: matchKey(input.title),
    matchKey: creditKey(input.artist, input.title),
    detailLevel: 0,
  })
  await db.insert(albumArtists).values({ albumId: id, position: 0, artistId, creditedName: input.artist })
  if (input.deezerId) await db.insert(externalIds).values({ provider: 'deezer', entityType: 'album', externalId: String(input.deezerId), entityId: id })
  return { albumId: id, artistId }
}

export async function albumRow(id: string) {
  const [row] = await db.select().from(albums).where(eq(albums.id, id))
  return row!
}

export async function artistRow(id: string) {
  const [row] = await db.select().from(artists).where(eq(artists.id, id))
  return row!
}
