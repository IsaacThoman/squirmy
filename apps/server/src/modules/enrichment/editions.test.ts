import { and, eq, sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { db } from '../../database/client.js'
import { albums, externalIds, likes } from '../../database/schema.js'
import { startJobs, stopJobs } from '../../jobs/index.js'
import { useTestDatabase } from '../../test/database.js'
import { createUser } from '../../test/factories.js'
import { useHttpFixtures } from '../../test/http.js'
import { albumRow, albumStub, artistStub } from '../../test/enrichment-stubs.js'
import { albumDetail } from '../catalog/pages.js'
import { mergeAlbum } from '../matching/merge.js'
import { hydrateAlbum } from './album.js'
import { splitMergedEditions } from './editions.js'
import { setDetailBudget } from './runner.js'

/** Deezer's albums of SZA's SOS, as the test instance had them on 2026-11-22. */
const sos = { standard: 383703577, deluxe: 686640951 }

async function trackCount(albumId: string) {
  const album = await albumRow(albumId)
  const [row] = await db.execute<{ count: number }>(sql`
    select count(*)::int as count from release_tracks where release_id = ${album.canonicalReleaseId}`)
  return row!.count
}

async function deezerIdsOf(albumId: string) {
  return (await db.select({ id: externalIds.externalId }).from(externalIds)
    .where(and(eq(externalIds.provider, 'deezer'), eq(externalIds.entityType, 'album'), eq(externalIds.entityId, albumId)))).map((row) => row.id)
}

describe('store editions of one release group', () => {
  useTestDatabase()
  useHttpFixtures('enrichment', 'musicbrainz', 'deezer', 'coverart')
  let userId = ''
  beforeAll(async () => {
    await startJobs({ work: false })
    userId = (await createUser()).id
  })
  afterAll(stopJobs)
  beforeEach(() => setDetailBudget(60_000))
  afterAll(() => setDetailBudget(4000))

  it('keeps the deluxe edition a page was opened for, and folds the standard one into the group', async () => {
    const sza = await artistStub({ name: 'SZA', deezerId: 4380 })
    const { albumId: deluxe } = await albumStub({ title: 'SOS Deluxe: LANA', artist: 'SZA', artistId: sza, deezerId: sos.deluxe })
    const { albumId: standard } = await albumStub({ title: 'SOS', artist: 'SZA', artistId: sza, deezerId: sos.standard })

    // The deluxe page: it stays its own row with its own songs, an edition of SOS.
    expect(await hydrateAlbum(deluxe)).toBe(deluxe)
    const opened = await albumRow(deluxe)
    expect(opened).toMatchObject({ title: 'SOS Deluxe: LANA', mbid: null, mergedIntoId: null })
    expect(opened.editionOfId).not.toBeNull()
    expect(await trackCount(deluxe)).toBeGreaterThan(30)
    const group = await albumRow(opened.editionOfId!)
    expect(group).toMatchObject({ title: 'SOS', type: 'album' })
    expect(group.mbid).not.toBeNull()
    // Asked again a while later, it still is.
    expect((await albumDetail(userId, deluxe)).discs.flatMap((disc) => disc.tracks).length).toBeGreaterThan(30)

    // The standard album from the store is the group's own edition: merged into its row.
    const merged = await hydrateAlbum(standard)
    expect(merged).toBe(group.id)
    expect(await trackCount(group.id)).toBe(23)
    expect(await deezerIdsOf(group.id)).toContain(String(sos.standard))
    expect((await albumRow(deluxe)).mergedIntoId).toBeNull()
  })

  it('splits off an edition that was merged into the group before editions were kept apart', async () => {
    const [deluxe] = await db.select().from(albums).where(eq(albums.title, 'SOS Deluxe: LANA'))
    const group = await albumRow(deluxe!.editionOfId!)
    // As the old code left it: the deluxe row merged into the group's row with its Deezer
    // id and a like.
    const user = await createUser()
    await db.insert(likes).values({ userId: user.id, entityType: 'album', entityId: deluxe!.id })
    await db.update(albums).set({ editionOfId: null }).where(eq(albums.id, deluxe!.id))
    await mergeAlbum(deluxe!.id, group.id)
    expect(await deezerIdsOf(group.id)).toContain(String(sos.deluxe))
    const old = deluxe!.id

    expect(await splitMergedEditions()).toBe(1)
    const split = await albumRow(old)
    expect(split).toMatchObject({ mergedIntoId: null, editionOfId: group.id })
    expect(await deezerIdsOf(old)).toEqual([String(sos.deluxe)])
    expect(await deezerIdsOf(group.id)).toEqual([String(sos.standard)])
    // The like stays where the merge moved it.
    expect(await db.select({ entityId: likes.entityId }).from(likes).where(eq(likes.userId, user.id))).toEqual([{ entityId: group.id }])
    // Opened again, the edition fetches its own track list.
    expect(await hydrateAlbum(old)).toBe(old)
    expect(await trackCount(old)).toBeGreaterThan(30)
    // Idempotent.
    expect(await splitMergedEditions()).toBe(0)
  })
})
