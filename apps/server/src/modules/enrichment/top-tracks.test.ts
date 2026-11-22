import { readFileSync } from 'node:fs'
import { eq, sql } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { db } from '../../database/client.js'
import { albumArtists, albums, artists, externalIds, recordings } from '../../database/schema.js'
import { creditKey, matchKey } from '../../lib/text.js'
import { useTestDatabase } from '../../test/database.js'
import { createUser } from '../../test/factories.js'
import { useHttpFixtures } from '../../test/http.js'
import { trackSummaries } from '../catalog/summaries.js'
import { deezer } from '../metadata/index.js'
import { releaseKey } from '../search/keys.js'
import { refreshTopTracks } from './artist.js'
import { deezerTopTrackRow } from './deezer-rows.js'
import type { ReleaseRow } from './reconcile.js'

/** The artist's MusicBrainz album rows as the test instance had them (`test/releases/*.json`). */
async function seedReleaseGroups(name: string, artist: { id: string; name: string }) {
  const file = new URL(`../../test/releases/${name}.json`, import.meta.url)
  const rows = (JSON.parse(readFileSync(file, 'utf8')) as { albums: ReleaseRow[] }).albums.filter((row) => row.mbid)
  for (const row of rows) {
    await db.insert(albums).values({
      id: row.id, mbid: row.mbid, title: row.title, artistCredit: artist.name, primaryArtistId: artist.id, type: row.type,
      year: row.year, titleKey: matchKey(row.title), matchKey: creditKey(artist.name, row.title), detailLevel: row.detailLevel,
    })
    await db.insert(albumArtists).values({ albumId: row.id, position: 0, artistId: artist.id, creditedName: artist.name })
  }
  return rows
}

async function artist(name: string, mbid: string, deezerId: string) {
  const [row] = await db.insert(artists).values({ id: crypto.randomUUID(), name, sortName: name, nameKey: matchKey(name), mbid, detailLevel: 2 }).returning()
  await db.insert(externalIds).values({ provider: 'deezer', entityType: 'artist', externalId: deezerId, entityId: row!.id })
  return { id: row!.id, name }
}

describe('Deezer top tracks', () => {
  useTestDatabase()
  useHttpFixtures('deezer')

  it('keep the album Deezer names, so each has artwork, and land on the release group of that title', async () => {
    const tate = await artist('Tate McRae', 'f9133869-f87c-459c-9aa7-2f176cda7e06', '13817211')
    const groups = await seedReleaseGroups('tate-mcrae', tate)
    const top = await deezer.getArtistTopTracks(13817211, { limit: 25 })
    expect(top.length).toBeGreaterThan(10)
    const ids: string[] = []
    for (const track of top) ids.push(await deezerTopTrackRow(tate.id, '13817211', track))

    const user = await createUser()
    const summaries = await trackSummaries(user.id, ids.map((id) => ({ id })))
    // Every popular track is shown on an album, with a cover.
    expect(summaries.filter((summary) => !summary.album?.artwork).map((summary) => summary.title)).toEqual([])

    // A song whose Deezer album is the single of its name is filed under that single (a
    // MusicBrainz group), not under a new album titled like the song.
    const byKey = new Map(groups.map((group) => [`${releaseKey(group.title)}|${group.type}`, group.id]))
    for (const [index, track] of top.entries()) {
      const albumTitle = track.album!.title
      const single = byKey.get(`${releaseKey(albumTitle)}|single`)
      if (single && releaseKey(albumTitle) === releaseKey(track.title)) expect(summaries[index]!.album!.id).toBe(single)
    }
    const shownOn = (title: string) => {
      const summary = summaries[top.findIndex((track) => track.title === title)]!
      const group = groups.find((one) => one.id === summary.album!.id)
      return group ? `${group.title} (${group.type})` : `${summary.album!.title} (not a release group)`
    }
    expect(shownOn('Sports car')).toBe('Sports car (single)')
    expect(shownOn('exes')).toBe('exes (single)')
    expect(shownOn("It's ok I'm ok")).toBe('It’s ok I’m ok (single)')
    expect(shownOn('TIT FOR TAT')).toBe('TIT FOR TAT (single)')
    expect(shownOn('you broke me first')).toBe('you broke me first (single)')
    expect(shownOn('Just Keep Watching (From F1® The Movie)')).toBe('Just Keep Watching (soundtrack)')
    expect(shownOn('run for the hills')).toBe('THINK LATER (album)')
    expect(shownOn("NOBODY'S GIRL")).toBe('So Close to What (album)')

    const stubs = await db.select({ title: albums.title, type: albums.type, typeGuessed: albums.typeGuessed }).from(albums)
      .where(sql`${albums.primaryArtistId} = ${tate.id} and ${albums.mbid} is null`)
    // Albums Deezer names that MusicBrainz does not list stay, with a guessed type.
    expect(stubs.every((stub) => stub.typeGuessed)).toBe(true)
    for (const stub of stubs) expect(groups.some((group) => releaseKey(group.title) === releaseKey(stub.title))).toBe(false)

    // Running it again changes nothing.
    const before = await db.execute(sql`select count(*)::int as albums from albums`)
    for (const track of top) await deezerTopTrackRow(tate.id, '13817211', track)
    expect(await db.execute(sql`select count(*)::int as albums from albums`)).toEqual(before)
  })

  it('drop the popularity of songs that left the ranking, so a song is not listed twice', async () => {
    const [tate] = await db.select({ id: artists.id }).from(artists).where(eq(artists.name, 'Tate McRae'))
    // A song ranked last time under a Deezer id the ranking no longer uses.
    const stale = crypto.randomUUID()
    await db.insert(recordings).values({ id: stale, title: 'exes', artistCredit: 'Tate McRae', primaryArtistId: tate!.id, titleKey: 'exes', matchKey: 'tate mcrae|exes', popularity: 0.9 })
    expect(await refreshTopTracks(tate!.id)).toBe(true)
    const [row] = await db.select({ popularity: recordings.popularity }).from(recordings).where(eq(recordings.id, stale))
    expect(row!.popularity).toBeNull()
    const ranked = await db.select({ id: recordings.id }).from(recordings).where(sql`${recordings.primaryArtistId} = ${tate!.id} and ${recordings.popularity} is not null`)
    expect(ranked.length).toBeGreaterThan(15)
  })

  it('credit a featured artist to the row of that name instead of a second row', async () => {
    const grimes = await artist('Grimes', '7e5a2a59-6d9f-4a17-b7c2-e1eedb7bd222', '807493')
    await seedReleaseGroups('grimes', grimes)
    const top = await deezer.getArtistTopTracks(807493, { limit: 25 })
    const featured = top.flatMap((track) => track.artists).filter((one) => String(one.id) !== '807493')
    expect(featured.length).toBeGreaterThan(0)
    // The discography credited these artists already, without a Deezer id.
    for (const one of featured) {
      await db.insert(artists).values({ id: crypto.randomUUID(), name: one.name, sortName: one.name, nameKey: matchKey(one.name) }).onConflictDoNothing()
    }
    const before = (await db.select({ id: artists.id }).from(artists)).length
    for (const track of top) await deezerTopTrackRow(grimes.id, '807493', track)
    expect((await db.select({ id: artists.id }).from(artists)).length).toBe(before + newNames(featured, top))

    const ids = await db.select({ id: recordings.id, title: recordings.title }).from(recordings).where(eq(recordings.primaryArtistId, grimes.id))
    const summaries = await trackSummaries((await createUser()).id, ids.map((row) => ({ id: row.id })))
    expect(summaries.filter((summary) => !summary.album?.artwork).map((summary) => summary.title)).toEqual([])
    // The songs the artist page showed without artwork.
    const albumOf = (title: string) => summaries.find((summary) => summary.title === title)?.album?.title
    expect(albumOf('Genesis')).toBe('Genesis')
    expect(albumOf('Realiti (Demo)')).toBe('Realiti (Demo)')
    expect(albumOf('We Appreciate Power')).toBe('Miss Anthropocene')
    // Another artist's track the page artist is featured on: that artist's album.
    const [flame] = await db.select({ id: recordings.id }).from(recordings).where(eq(recordings.title, 'Face The Flamë'))
    expect((await trackSummaries((await createUser()).id, [{ id: flame!.id }]))[0]!.album).toMatchObject({ title: 'ADL', artwork: expect.anything() })
  })
})

/** Main artists of other artists' tracks that nothing credited before: those get rows of their own. */
function newNames(featured: { name: string }[], top: { artist: { id: number; name: string } }[]) {
  const known = new Set(featured.map((one) => matchKey(one.name)))
  return new Set(top.map((track) => matchKey(track.artist.name)).filter((name) => name !== matchKey('Grimes') && !known.has(name))).size
}
