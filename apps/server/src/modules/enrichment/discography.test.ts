import { eq, sql } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { db } from '../../database/client.js'
import { albums } from '../../database/schema.js'
import { useTestDatabase } from '../../test/database.js'
import { createLibraryRoot } from '../../test/factories.js'
import { createFile } from '../../test/catalog.js'
import type { MbReleaseGroupSummary } from '../metadata/musicbrainz.js'
import { upsertDiscography } from './artist.js'
import { albumRow, albumStub, artistStub } from './test-stubs.js'

const deathGrips = { name: 'Death Grips', mbid: '3d1b0d8b-1f6b-4a1e-8f7c-000000000001' }

function group(title: string, mbid: string, type: MbReleaseGroupSummary['type'] = 'album'): MbReleaseGroupSummary {
  return {
    mbid, title, type, primaryType: type, secondaryTypes: [], disambiguation: '', date: '2012', year: 2012,
    artistCredit: [{ name: deathGrips.name, mbid: deathGrips.mbid, joinPhrase: '' }], artistName: deathGrips.name,
  }
}

async function albumsNamed(title: string) {
  return db.select({ id: albums.id, mbid: albums.mbid }).from(albums)
    .where(sql`${albums.titleKey} like ${`${title.toLowerCase()}%`} and ${albums.mergedIntoId} is null`)
}

describe('artist discography', () => {
  useTestDatabase()

  it('adopts the Deezer stubs of the same albums instead of listing them twice', async () => {
    const artistId = await artistStub({ name: deathGrips.name, mbid: deathGrips.mbid })
    const { albumId: moneyStore } = await albumStub({ title: 'The Money Store', artist: deathGrips.name, artistId, deezerId: 5101 })
    const { albumId: snitch } = await albumStub({ title: 'Year Of The Snitch (Deluxe Edition)', artist: deathGrips.name, artistId, deezerId: 5102 })
    // A single that shares an album's title is another release group.
    const { albumId: single } = await albumStub({ title: 'Bottomless Pit', artist: deathGrips.name, artistId, deezerId: 5103 })
    await db.update(albums).set({ type: 'single' }).where(eq(albums.id, single))

    await upsertDiscography([
      group('The Money Store', 'a0000000-0000-4000-8000-000000000001'),
      group('Year of the Snitch', 'a0000000-0000-4000-8000-000000000002'),
      group('Bottomless Pit', 'a0000000-0000-4000-8000-000000000003'),
    ])

    expect(await albumRow(moneyStore)).toMatchObject({ mbid: 'a0000000-0000-4000-8000-000000000001', mergedIntoId: null, detailLevel: 1 })
    expect(await albumsNamed('The Money Store')).toHaveLength(1)
    expect(await albumsNamed('Year of the Snitch')).toEqual([{ id: snitch, mbid: 'a0000000-0000-4000-8000-000000000002' }])
    expect((await albumRow(single)).mbid).toBeNull()
    expect(await albumsNamed('Bottomless Pit')).toHaveLength(2)
  })

  it('merges a stub into the row that already has the release group', async () => {
    const [artist] = await db.execute<{ id: string }>(sql`select id from artists where mbid = ${deathGrips.mbid}`)
    const { albumId: late } = await albumStub({ title: 'The Money Store', artist: deathGrips.name, artistId: artist!.id, deezerId: 5104 })
    await upsertDiscography([group('The Money Store', 'a0000000-0000-4000-8000-000000000001')])
    expect((await albumRow(late)).mergedIntoId).not.toBeNull()
    expect(await albumsNamed('The Money Store')).toHaveLength(1)
  })

  it('leaves stubs alone when titles are ambiguous, or the stub has files', async () => {
    const artistId = await artistStub({ name: 'Weezer', mbid: '3d1b0d8b-1f6b-4a1e-8f7c-000000000002' })
    const credit = [{ name: 'Weezer', mbid: '3d1b0d8b-1f6b-4a1e-8f7c-000000000002', joinPhrase: '' }]
    const { albumId: stub } = await albumStub({ title: 'Weezer', artist: 'Weezer', artistId, deezerId: 5201 })
    const { albumId: owned } = await albumStub({ title: 'Pinkerton', artist: 'Weezer', artistId })
    await createFile({ rootId: (await createLibraryRoot()).id, recordingId: (await db.execute<{ id: string }>(sql`
      insert into recordings (id, title, artist_credit, title_key, match_key) values (gen_random_uuid(), 'Tired of Sex', 'Weezer', 'tired of sex', 'weezer|tired of sex') returning id`))[0]!.id, albumId: owned })
    await upsertDiscography([
      { ...group('Weezer', 'b0000000-0000-4000-8000-000000000001'), artistCredit: credit, artistName: 'Weezer' },
      { ...group('Weezer', 'b0000000-0000-4000-8000-000000000002'), artistCredit: credit, artistName: 'Weezer' },
      { ...group('Pinkerton', 'b0000000-0000-4000-8000-000000000003'), artistCredit: credit, artistName: 'Weezer' },
    ])
    expect((await albumRow(stub)).mbid).toBeNull()
    expect((await albumRow(owned)).mbid).toBeNull()
  })
})
