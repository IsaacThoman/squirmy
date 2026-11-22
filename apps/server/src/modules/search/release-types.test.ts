import { readFileSync } from 'node:fs'
import { eq, sql } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { db } from '../../database/client.js'
import { albumArtists, albums, artists, externalIds } from '../../database/schema.js'
import { creditKey, matchKey } from '../../lib/text.js'
import { useTestDatabase } from '../../test/database.js'
import { createAlbum, createArtist } from '../../test/factories.js'
import { useHttpFixtures } from '../../test/http.js'
import type { ReleaseRow } from '../enrichment/reconcile.js'
import { releaseKey } from './keys.js'
import { materialize } from './materialize.js'
import { searchCatalog, type ProviderAlbum, type ProviderResults, type ProviderTrack } from './providers.js'

const tate = { name: 'Tate McRae', mbid: 'f9133869-f87c-459c-9aa7-2f176cda7e06' }

/** Tate McRae's MusicBrainz album rows as the test instance had them (`test/releases/tate-mcrae.json`). */
async function seedTate() {
  const [artist] = await db.insert(artists).values({ id: crypto.randomUUID(), name: tate.name, sortName: tate.name, nameKey: matchKey(tate.name), mbid: tate.mbid, detailLevel: 2 }).returning()
  await db.insert(externalIds).values({ provider: 'deezer', entityType: 'artist', externalId: '13817211', entityId: artist!.id })
  const file = new URL('../../test/releases/tate-mcrae.json', import.meta.url)
  const groups = (JSON.parse(readFileSync(file, 'utf8')) as { albums: ReleaseRow[] }).albums.filter((row) => row.mbid)
  for (const row of groups) {
    await db.insert(albums).values({
      id: row.id, mbid: row.mbid, title: row.title, artistCredit: tate.name, primaryArtistId: artist!.id, type: row.type,
      year: row.year, titleKey: matchKey(row.title), matchKey: creditKey(tate.name, row.title), detailLevel: row.detailLevel,
    })
    await db.insert(albumArtists).values({ albumId: row.id, position: 0, artistId: artist!.id, creditedName: tate.name })
  }
  return { artistId: artist!.id, groups }
}

const credit = (name: string) => [{ id: `dz-${name}`, mbid: null, name, joinPhrase: '' }]
function trackAlbum(id: string, title: string, artist: string): ProviderAlbum {
  return { id, mbid: null, title, artistCredit: artist, artists: credit(artist), type: null, year: null, releaseDate: null, artworkUrl: null }
}
function track(id: string, title: string, artist: string, album: ProviderAlbum | null): ProviderTrack {
  return { id, mbid: null, title, artistCredit: artist, artists: credit(artist), durationMs: 180_000, explicit: false, popularity: 0.5, isrcs: [], album }
}

describe('album types of catalog search results', () => {
  useTestDatabase()
  useHttpFixtures('deezer')

  it('files a song’s album reference under the release group of that title instead of a new "album"', async () => {
    const { artistId, groups } = await seedTate()
    const { provider, results } = await searchCatalog('tate mcrae', 25)
    expect(provider?.name).toBe('deezer')
    expect(results.tracks.length).toBeGreaterThan(5)
    await materialize('deezer', results)

    const stubs = await db.select({ title: albums.title, type: albums.type, typeGuessed: albums.typeGuessed }).from(albums)
      .where(sql`${albums.primaryArtistId} = ${artistId} and ${albums.mbid} is null and ${albums.mergedIntoId} is null`)
    // Every album the response names for her songs is one of her release groups, or a
    // release MusicBrainz does not list (typed by Deezer, or a marked guess).
    const keys = new Set(groups.map((group) => releaseKey(group.title)))
    const duplicates = stubs.filter((stub) => stub.typeGuessed && keys.has(releaseKey(stub.title)))
    expect(duplicates).toEqual([])
    expect(stubs.filter((stub) => stub.typeGuessed && stub.type === 'album' && results.tracks.some((one) => releaseKey(one.title) === releaseKey(stub.title)))).toEqual([])
  })

  it('guesses a single for an album titled like its song, and takes the type Deezer states later', async () => {
    const results: ProviderResults = { artists: [], albums: [], tracks: [track('t1', 'Housewife', 'Fixture Singer', trackAlbum('a1', 'Housewife', 'Fixture Singer'))] }
    const { tracks: [recordingId] } = await materialize('deezer', results)
    const [stub] = await db.execute<{ id: string; type: string; typeGuessed: boolean; year: number | null }>(sql`
      select a.id, a.type, a.type_guessed as "typeGuessed", a.year from recordings r join albums a on a.id = r.album_hint_id where r.id = ${recordingId!}`)
    expect(stub).toMatchObject({ type: 'single', typeGuessed: true, year: null })

    // The album itself in a later answer, with its type and date.
    await materialize('deezer', { artists: [], albums: [{ ...trackAlbum('a1', 'Housewife', 'Fixture Singer'), type: 'ep', year: 2026, releaseDate: '2026-11-13' }], tracks: [] })
    const [after] = await db.select({ type: albums.type, typeGuessed: albums.typeGuessed, year: albums.year }).from(albums).where(eq(albums.id, stub!.id))
    expect(after).toEqual({ type: 'ep', typeGuessed: false, year: 2026 })
  })

  it('merges a stub into the owned album that took its provider id, instead of leaving it beside it', async () => {
    const band = 'Late Singer'
    const results: ProviderResults = { artists: [], albums: [], tracks: [track('t2', 'TIT FOR TAT', band, trackAlbum('a2', 'TIT FOR TAT', band))] }
    const first = await materialize('deezer', results)
    const [stub] = await db.execute<{ id: string }>(sql`select album_hint_id as id from recordings where id = ${first.tracks[0]!}`)
    const owned = await createAlbum({ title: 'TIT FOR TAT', type: 'single', artist: await createArtist({ name: band }), owned: true, tracks: [{ title: 'TIT FOR TAT', durationMs: 181_000 }] })
    const again = await materialize('deezer', results)
    expect(again.tracks).toEqual([owned.tracks[0]!.recordingId])
    const [row] = await db.select({ mergedIntoId: albums.mergedIntoId }).from(albums).where(eq(albums.id, stub!.id))
    expect(row!.mergedIntoId).toBe(owned.albumId)
    // The stub recording went the same way, so the song is listed once.
    const [recording] = await db.execute<{ mergedIntoId: string | null }>(sql`select merged_into_id as "mergedIntoId" from recordings where id = ${first.tracks[0]!}`)
    expect(recording!.mergedIntoId).toBe(owned.tracks[0]!.recordingId)
  })
})
