import { eq, sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { db } from '../../database/client.js'
import { albums, releases } from '../../database/schema.js'
import { startJobs, stopJobs } from '../../jobs/index.js'
import { updateServerSettings } from '../../lib/settings.js'
import { useTestDatabase } from '../../test/database.js'
import { albumRow, albumStub } from '../../test/enrichment-stubs.js'
import { createUser } from '../../test/factories.js'
import { useHttpFixtures } from '../../test/http.js'
import { albumDetail } from '../catalog/pages.js'
import { albumDetailRun } from './detail.js'
import { keepNamedEditions, queueEditionCheck } from './named-editions.js'
import { setDetailBudget } from './runner.js'

/** Tate McRae's So Close to What: the deluxe, "SO CLOSE TO WHAT???", is a release of the same group. */
const soCloseToWhat = '3607f069-61cb-4e4a-b450-863ad0cf7f95'

const songTitles = (page: Awaited<ReturnType<typeof albumDetail>>) => page.discs.flatMap((disc) => disc.tracks.map((track) => track.title))

describe('editions with a title of their own', () => {
  useTestDatabase()
  const http = useHttpFixtures('editions', 'musicbrainz', 'coverart')
  let userId = ''
  beforeAll(async () => {
    await startJobs({ work: false })
    userId = (await createUser()).id
    await updateServerSettings({ deezerEnabled: false })
    setDetailBudget(60_000)
  })
  afterAll(async () => {
    setDetailBudget(4000)
    await stopJobs()
  })

  it('keeps the deluxe as an edition row the album page lists as a version, and the other way round', async () => {
    const { albumId } = await albumStub({ title: 'So Close to What', artist: 'Tate McRae', mbid: soCloseToWhat })
    await albumDetailRun(albumId)
    const standard = await albumDetail(userId, albumId)
    // The standard edition, though MusicBrainz lists nearly as many deluxe pressings.
    expect(standard.discs.flatMap((disc) => disc.tracks)).toHaveLength(13)
    expect(standard.versions).toEqual([])
    const [queuedFirst] = await db.execute<{ due: boolean }>(sql`select count(*) > 0 as due from pgboss.job where name = 'enrichment.editions' and data->>'albumId' = ${albumId}`)
    expect(queuedFirst?.due).toBe(true)

    const [deluxeId, ...others] = await keepNamedEditions(albumId)
    expect(others).toEqual([])
    const deluxe = await albumRow(deluxeId!)
    expect(deluxe).toMatchObject({ title: 'SO CLOSE TO WHAT???', mbid: null, editionOfId: albumId, primaryArtistId: (await albumRow(albumId)).primaryArtistId, type: 'album', detailLevel: 2, releaseDate: '2025-11-21' })
    expect(deluxe.artworkAssetId).not.toBeNull()

    const withVersions = await albumDetail(userId, albumId)
    expect(withVersions.versions?.map((album) => album.id)).toEqual([deluxeId])
    const deluxePage = await albumDetail(userId, deluxeId!)
    expect(deluxePage.title).toBe('SO CLOSE TO WHAT???')
    expect(deluxePage.discs.flatMap((disc) => disc.tracks)).toHaveLength(21)
    expect(deluxePage.versions?.map((album) => album.id)).toEqual([albumId])
    // The songs of both are the same recordings, so a copy of one plays on the other.
    const shared = songTitles(standard).filter((title) => songTitles(deluxePage).includes(title))
    // The CD has two songs the deluxe left out.
    expect(shared).toHaveLength(11)
    const ids = (page: typeof standard) => new Map(page.discs.flatMap((disc) => disc.tracks.map((track) => [track.title, track.id])))
    expect(shared.every((title) => ids(standard).get(title) === ids(deluxePage).get(title))).toBe(true)

    // Checked: nothing is asked or written again for 30 days.
    http.requests.length = 0
    expect(await keepNamedEditions(albumId)).toEqual([])
    await db.execute(sql`delete from pgboss.job where name = 'enrichment.editions'`)
    await queueEditionCheck(albumId)
    const [after] = await db.execute<{ queued: number }>(sql`select count(*)::int as queued from pgboss.job where name = 'enrichment.editions'`)
    expect(after?.queued).toBe(0)
    // An edition row's editions are its group's, checked already.
    await queueEditionCheck(deluxeId!)
    const [afterEdition] = await db.execute<{ queued: number }>(sql`select count(*)::int as queued from pgboss.job where name = 'enrichment.editions'`)
    expect(afterEdition?.queued).toBe(0)
    expect(await keepNamedEditions(deluxeId!)).toEqual([])
    expect(await db.select({ id: releases.id }).from(releases).where(eq(releases.albumId, deluxeId!))).toHaveLength(1)
    expect((await db.select({ id: albums.id }).from(albums).where(eq(albums.editionOfId, albumId)))).toHaveLength(1)
  })
  it('merges the edition row into the store album of that edition when one is opened', async () => {
    const [group] = await db.select({ id: albums.id }).from(albums).where(eq(albums.mbid, soCloseToWhat))
    const [made] = await db.select({ id: albums.id }).from(albums).where(eq(albums.editionOfId, group!.id))
    await updateServerSettings({ deezerEnabled: true })
    try {
      const { albumId: store } = await albumStub({ title: 'SO CLOSE TO WHAT??? (deluxe)', artist: 'Tate McRae', deezerId: 859781272 })
      await albumDetailRun(store)
      expect(await albumRow(made!.id)).toMatchObject({ mergedIntoId: store })
      expect(await albumRow(store)).toMatchObject({ editionOfId: group!.id, mergedIntoId: null })
      const page = await albumDetail(userId, store)
      expect(page.discs.flatMap((disc) => disc.tracks)).toHaveLength(21)
      expect(page.versions?.map((album) => album.id)).toEqual([group!.id])
      expect((await albumDetail(userId, group!.id)).versions?.map((album) => album.id)).toEqual([store])
      // The row it was opened as still answers, as the store album.
      expect((await albumDetail(userId, made!.id)).id).toBe(store)
    } finally {
      await updateServerSettings({ deezerEnabled: false })
    }
  })
})
