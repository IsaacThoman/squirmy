import { eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it } from 'vitest'
import { db } from '../../database/client.js'
import { albums, artists, externalIds } from '../../database/schema.js'
import { updateServerSettings } from '../../lib/settings.js'
import { createAsset } from '../../test/catalog.js'
import { useTestDatabase } from '../../test/database.js'
import { albumRow, albumStub, artistRow, artistStub } from '../../test/enrichment-stubs.js'
import { createArtist } from '../../test/factories.js'
import { useHttpFixtures } from '../../test/http.js'
import { resolveOne } from '../catalog/redirects.js'
import { bridgeNamesakes, resetNamesakes } from './namesakes.js'

/**
 * The live duplicates of 2026-11-22: Deezer's second "Boards of Canada" (412310471, 2 fans)
 * and "Daft Punk" (412557421, 0 fans) were stored by search as artists of their own beside
 * the MusicBrainz rows that hold Deezer's main pages, and both showed in search.
 */
describe('bridging Deezer-only namesakes', () => {
  useTestDatabase()
  const http = useHttpFixtures('enrichment', 'musicbrainz')

  beforeEach(async () => {
    resetNamesakes()
    await updateServerSettings({ musicBrainzEnabled: true })
  })

  async function known(name: string, mbid: string, deezerId: number) {
    const artist = await createArtist({ name, mbid })
    await db.insert(externalIds).values({ provider: 'deezer', entityType: 'artist', externalId: String(deezerId), entityId: artist.id })
    return artist.id
  }

  it('merges a stub MusicBrainz names surely into the artist with that MBID, and leaves an unsure one and lone names alone', async () => {
    const daftPunk = await known('Daft Punk', '056e4f3e-d505-4dad-8ec1-d04f521cbb56', 27)
    const daftCopy = await artistStub({ name: 'Daft Punk', deezerId: 412557421 })
    const boards = await known('Boards of Canada', '69158f97-4c07-4c4e-baf8-4e4ab1ed666e', 1098)
    const boardsCopy = await artistStub({ name: 'Boards of Canada', deezerId: 412310471 })
    // A name no other row has is nobody's duplicate: not looked up.
    const lone = await artistStub({ name: 'Nobody Else Is Called This', deezerId: 99 })

    // As with Grimes: search stored the copy's albums under it, so the discography written
    // for the MusicBrainz row could not adopt them.
    const { albumId: homework } = await albumStub({ title: 'Homework', artist: 'Daft Punk', artistId: daftPunk, mbid: '00000000-0000-4000-8000-00000000d0a1', year: 1997 })
    // With a cover, so the sweep below has no cover to look for.
    await db.update(albums).set({ artworkAssetId: (await createAsset()).id }).where(eq(albums.id, homework))
    const { albumId: homeworkStub } = await albumStub({ title: 'Homework', artist: 'Daft Punk', artistId: daftCopy, deezerId: 302127 })

    expect(await bridgeNamesakes()).toEqual([daftCopy])
    expect(await albumRow(homeworkStub)).toMatchObject({ mergedIntoId: homework })

    // The second "Daft Punk" is a redirect to the first, with its Deezer id.
    expect(await resolveOne('artists', daftCopy)).toBe(daftPunk)
    expect((await db.select({ entityId: externalIds.entityId }).from(externalIds).where(eq(externalIds.externalId, '412557421')))).toEqual([{ entityId: daftPunk }])
    // MusicBrainz has two "Boards of Canada" (one for mistagged releases): not sure, so apart.
    expect(await artistRow(boardsCopy)).toMatchObject({ mbid: null, mergedIntoId: null })
    expect(await artistRow(boards)).toMatchObject({ mergedIntoId: null })
    expect(await artistRow(lone)).toMatchObject({ mbid: null, mergedIntoId: null })
    expect(http.requests.filter((url) => url.includes('Nobody') || url.includes('%2F99&'))).toEqual([])

    // Tried once a day: the next sweep asks nothing again.
    const asked = http.requests.length
    expect(await bridgeNamesakes()).toEqual([])
    expect(http.requests).toHaveLength(asked)
    expect(await db.select({ id: artists.id }).from(artists).where(eq(artists.nameKey, 'daft punk'))).toHaveLength(2)
  })

  it('asks nothing while MusicBrainz is off', async () => {
    await updateServerSettings({ musicBrainzEnabled: false })
    const { sweep } = await import('./sweep.js')
    const before = http.requests.length
    await sweep()
    expect(http.requests).toHaveLength(before)
  })
})
