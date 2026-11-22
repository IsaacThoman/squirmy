import { readFileSync } from 'node:fs'
import { eq, sql } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { db } from '../../database/client.js'
import { albumArtists, albums, externalIds, likes, mediaFiles, playlistItems, playlists, plays, recordings } from '../../database/schema.js'
import { newId } from '../../lib/ids.js'
import { creditKey, matchKey } from '../../lib/text.js'
import { createFile } from '../../test/catalog.js'
import { useTestDatabase } from '../../test/database.js'
import { createArtist, createLibraryRoot, createUser } from '../../test/factories.js'
import { planReleaseMerges, reconcileAllArtists, reconcileArtistAlbums, type ReleaseRow } from './reconcile.js'

type Recorded = ReleaseRow & { deezerIds: string | null }

/** Album rows of an artist as the test instance had them (`test/releases/*.json`). */
function recorded(name: string): Recorded[] {
  const file = new URL(`../../test/releases/${name}.json`, import.meta.url)
  return (JSON.parse(readFileSync(file, 'utf8')) as { albums: Recorded[] }).albums
}

/** The planned merges as "loser title (year) -> winner title (year)" lines, sorted. */
function described(rows: readonly Recorded[]) {
  const label = (row: ReleaseRow) => `${row.title} (${row.year ?? '-'}, ${row.type}${row.mbid ? ', mb' : ''})`
  return planReleaseMerges(rows).map(([from, into]) => `${label(from)} -> ${label(into)}`).sort()
}

describe('release reconciliation plan, on recorded discographies', () => {
  it('folds the Grimes stubs into their release groups and leaves distinct releases alone', () => {
    expect(described(recorded('grimes'))).toEqual([
      // Search stubs written under a second Grimes row, merged into the MusicBrainz artist after its discography ran.
      'Art Angels (-, album) -> Art Angels (2015, album, mb)',
      // Deezer calls it an EP; the MusicBrainz group of that type wins over the compilation of the same name.
      'Darkbloom (-, ep) -> Darkbloom (2011, ep, mb)',
      'Entropy (-, single) -> Entropy (2015, single, mb)',
      'Halfaxa (-, album) -> Halfaxa (2010, album, mb)',
      // The deluxe edition is the same release.
      'Miss Anthropocene (Deluxe Edition) (-, album) -> Miss Anthropocene (2019, album, mb)',
      // MusicBrainz has two "Violence" singles; the stub joins the one the page shows.
      'Violence (-, single) -> Violence (2019, single, mb)',
      '爱 (-, single) -> 爱 (2026, single, mb)',
    ])
  })

  it('folds the Tate McRae song-titled "albums" into the singles and soundtrack they are', () => {
    expect(described(recorded('tate-mcrae'))).toEqual([
      // Album references of popular tracks: no type, so they were stored as albums titled like the song.
      'It\'s ok I\'m ok (-, album) -> It’s ok I’m ok (2024, single, mb)',
      'Just Keep Watching (From F1® The Movie) (-, album) -> Just Keep Watching (2025, soundtrack, mb)',
      'Sports car (-, album) -> Sports car (2025, single, mb)',
      // A stub whose Deezer id search moved to the owned single, left behind beside it.
      'TIT FOR TAT (-, album) -> TIT FOR TAT (2025, single, mb)',
      'exes (-, album) -> exes (2023, single, mb)',
      // Built from a delivered file's tags (type defaulted to album) and kept by a play after the file moved.
      'you broke me first (2020, album) -> you broke me first (2020, single, mb)',
    ])
  })

  it('keeps a single and an album of one title apart when both types are stated', () => {
    const row = (id: string, type: string, extra: Partial<ReleaseRow> = {}): ReleaseRow => ({
      id, title: 'Bottomless Pit', type, typeGuessed: false, mbid: null, year: null, detailLevel: 0, hasFiles: false, hasArtwork: true, ...extra,
    })
    expect(planReleaseMerges([row('a', 'album', { mbid: 'x', year: 2016 }), row('b', 'single')])).toEqual([])
    // Guessed, it joins the release group.
    expect(planReleaseMerges([row('a', 'album', { mbid: 'x', year: 2016 }), row('b', 'single', { typeGuessed: true })]).map(([from]) => from.id)).toEqual(['b'])
    // Years far apart are different releases (a re-recording, a reissue under the old title).
    expect(planReleaseMerges([row('a', 'album', { mbid: 'x', year: 2001 }), row('b', 'album', { year: 2016 })])).toEqual([])
  })

  it('merges stubs of one release that no MusicBrainz row stands for into the best of them', () => {
    const rows: ReleaseRow[] = [
      { id: 'a', title: 'exes', type: 'album', typeGuessed: true, mbid: null, year: null, detailLevel: 0, hasFiles: false, hasArtwork: true },
      { id: 'b', title: 'exes', type: 'single', typeGuessed: false, mbid: null, year: 2023, detailLevel: 0, hasFiles: false, hasArtwork: true },
    ]
    expect(planReleaseMerges(rows).map(([from, into]) => [from.id, into.id])).toEqual([['a', 'b']])
  })
})

describe('reconcileArtistAlbums', () => {
  useTestDatabase()

  async function album(artist: { id: string; name: string }, title: string, values: Partial<typeof albums.$inferInsert> = {}) {
    const id = newId()
    await db.insert(albums).values({
      id, title, artistCredit: artist.name, primaryArtistId: artist.id, titleKey: matchKey(title), matchKey: creditKey(artist.name, title), ...values,
    })
    await db.insert(albumArtists).values({ albumId: id, position: 0, artistId: artist.id, creditedName: artist.name })
    return id
  }

  async function recording(artist: { id: string; name: string }, title: string, albumHintId: string | null = null) {
    const id = newId()
    await db.insert(recordings).values({ id, title, artistCredit: artist.name, primaryArtistId: artist.id, titleKey: matchKey(title), matchKey: creditKey(artist.name, title), albumHintId })
    return id
  }

  it('merges stubs into the release group and keeps what users pointed at them', async () => {
    const tate = await createArtist({ name: 'Tate McRae', mbid: 'f9133869-f87c-459c-9aa7-2f176cda7e06' })
    const single = await album(tate, 'Sports car', { mbid: 'b1d42e45-c3d0-4f98-a8ce-ac9007067349', type: 'single', year: 2025, detailLevel: 1 })
    const owned = await album(tate, 'TIT FOR TAT', { mbid: '632c472b-bc2d-466f-b008-a24e1a197545', type: 'single', year: 2025, detailLevel: 2 })
    const stub = await album(tate, 'Sports car', { type: 'album', typeGuessed: true })
    await db.insert(externalIds).values({ provider: 'deezer', entityType: 'album', externalId: '701157501', entityId: stub })
    const orphan = await album(tate, 'TIT FOR TAT', { type: 'album', typeGuessed: true })
    const album2023 = await album(tate, 'THINK LATER', { mbid: '6e924cee-9945-4a1b-b4c6-3445f846c01f', year: 2023, detailLevel: 2 })
    const song = await recording(tate, 'Sports car', stub)
    const owner = await createUser()
    const root = await createLibraryRoot()
    await createFile({ rootId: root.id, recordingId: await recording(tate, 'TIT FOR TAT'), albumId: owned })
    // Two saves (the heart), each of a row that gives way.
    await db.insert(likes).values({ userId: owner.id, entityType: 'album', entityId: stub })
    await db.insert(likes).values({ userId: owner.id, entityType: 'album', entityId: orphan })
    const [playlist] = await db.insert(playlists).values({ id: newId(), ownerId: owner.id, name: 'Mix' }).returning()
    await db.insert(playlistItems).values({ id: newId(), playlistId: playlist!.id, position: 0, recordingId: song, albumId: stub })
    await db.insert(plays).values({ id: newId(), userId: owner.id, recordingId: song, albumId: stub })

    expect((await reconcileArtistAlbums(tate.id)).sort()).toEqual([orphan, stub].sort())

    const row = async (id: string) => (await db.select().from(albums).where(eq(albums.id, id)))[0]!
    expect((await row(stub)).mergedIntoId).toBe(single)
    expect((await row(orphan)).mergedIntoId).toBe(owned)
    expect((await row(album2023)).mergedIntoId).toBeNull()
    expect((await db.select({ entityId: likes.entityId }).from(likes)).map((row) => row.entityId).sort()).toEqual([single, owned].sort())
    expect(await db.select({ albumId: playlistItems.albumId }).from(playlistItems)).toEqual([{ albumId: single }])
    expect(await db.select({ albumId: plays.albumId }).from(plays)).toEqual([{ albumId: single }])
    expect((await db.select({ hint: recordings.albumHintId }).from(recordings).where(eq(recordings.id, song)))[0]!.hint).toBe(single)
    expect(await db.select({ entityId: externalIds.entityId }).from(externalIds).where(eq(externalIds.externalId, '701157501'))).toEqual([{ entityId: single }])
    expect(await db.select({ albumId: mediaFiles.albumId }).from(mediaFiles)).toEqual([{ albumId: owned }])

    // Idempotent.
    expect(await reconcileArtistAlbums(tate.id)).toEqual([])
  })

  it('repairs every artist with a loose row, and only those', async () => {
    const grimes = await createArtist({ name: 'Grimes', mbid: '7e5a2a59-6d9f-4a17-b7c2-e1eedb7bd222' })
    const halfaxa = await album(grimes, 'Halfaxa', { mbid: 'a5c4a9f0-0000-4000-8000-000000000001', year: 2010, detailLevel: 1 })
    const stub = await album(grimes, 'Halfaxa', { type: 'album', typeGuessed: true })
    const before = await reconcileAllArtists()
    expect(before).toBeGreaterThanOrEqual(1)
    expect((await db.select({ into: albums.mergedIntoId }).from(albums).where(eq(albums.id, stub)))[0]!.into).toBe(halfaxa)
    expect(await reconcileAllArtists()).toBe(0)
    const [left] = await db.execute<{ count: number }>(sql`
      select count(*)::int as count from albums where primary_artist_id = ${grimes.id} and merged_into_id is null`)
    expect(left!.count).toBe(1)
  })
})
