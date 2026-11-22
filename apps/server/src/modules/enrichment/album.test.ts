import { and, eq, sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '../../database/client.js'
import { albums, externalIds, httpCache, recordings, releases, releaseTracks } from '../../database/schema.js'
import { newId } from '../../lib/ids.js'
import { creditKey, matchKey } from '../../lib/text.js'
import { startJobs, stopJobs } from '../../jobs/index.js'
import { updateServerSettings } from '../../lib/settings.js'
import { useTestDatabase } from '../../test/database.js'
import { createFile } from '../../test/catalog.js'
import { createAlbum, createArtist, createLibraryRoot, createUser } from '../../test/factories.js'
import { useHttpFixtures } from '../../test/http.js'
import { albumDetail } from '../catalog/pages.js'
import { hydrateAlbum } from './album.js'
import { albumDetailRun, ensureAlbumDetail } from './detail.js'
import { setDetailBudget } from './runner.js'
import { albumRow, albumStub, artistStub } from './test-stubs.js'

const radiohead = 'a74b1b7f-71a5-4011-9441-d0b5e4122711'
const okComputer = 'b1392450-e666-3926-a536-22c65f834433'
/** The first official 12-track CD, as chooseCanonicalRelease picks it. */
const okComputerCanonical = '1834eae1-741b-3c03-9ca5-0df3decb43ea'
/** A made-up id that the hand-written fixtures answer with OK Computer, as MusicBrainz does for a merged id. */
const mergedOkComputer = 'b1392450-0000-4000-8000-000000000000'

async function canonical(albumId: string) {
  const album = await albumRow(albumId)
  const [release] = await db.select().from(releases).where(eq(releases.id, album.canonicalReleaseId!))
  const tracks = await db.select({ title: releaseTracks.title, disc: releaseTracks.disc, position: releaseTracks.position, isrcs: recordings.isrcs, mbid: recordings.mbid })
    .from(releaseTracks).innerJoin(recordings, eq(recordings.id, releaseTracks.recordingId))
    .where(eq(releaseTracks.releaseId, release!.id)).orderBy(releaseTracks.disc, releaseTracks.position)
  return { album, release: release!, tracks }
}

async function deezerIdsOf(entityType: 'album' | 'recording', entityId: string) {
  return (await db.select({ id: externalIds.externalId }).from(externalIds)
    .where(and(eq(externalIds.provider, 'deezer'), eq(externalIds.entityType, entityType), eq(externalIds.entityId, entityId)))).map((row) => row.id)
}

/** Its own database and fixtures, with jobs startable and a user to view pages as. */
function useAlbumTests() {
  useTestDatabase()
  const http = useHttpFixtures('enrichment', 'musicbrainz', 'deezer', 'coverart')
  const context = { userId: '', http }
  beforeAll(async () => {
    await startJobs({ work: false })
    context.userId = (await createUser()).id
  })
  afterAll(stopJobs)
  // Recording waits out MusicBrainz's rate limit; only the budget test wants a short one.
  beforeEach(() => setDetailBudget(60_000))
  afterAll(() => setDetailBudget(4000))
  return context
}

describe('album detail from each source', () => {
  const context = useAlbumTests()
  const { http } = context

  it('fills in an album stub that only has a release-group MBID with its canonical edition', async () => {
    const { albumId } = await albumStub({ title: 'OK Computer', artist: 'Radiohead', mbid: okComputer })
    await ensureAlbumDetail(albumId)

    const { album, release, tracks } = await canonical(albumId)
    expect(album).toMatchObject({ mbid: okComputer, detailLevel: 2 })
    expect(album.genres.length).toBeGreaterThan(0)
    expect(release).toMatchObject({ mbid: okComputerCanonical, status: 'official', trackCount: 12 })
    expect(tracks.map((track) => track.title).slice(0, 3)).toEqual(['Airbag', 'Paranoid Android', 'Subterranean Homesick Alien'])
    expect(tracks.every((track) => track.mbid)).toBe(true)
    const page = await albumDetail(context.userId, albumId)
    expect(page.discs[0]!.tracks).toHaveLength(12)

    // Fresh now: nothing is asked again.
    http.requests.length = 0
    await ensureAlbumDetail(albumId)
    expect(http.requests).toEqual([])
  })

  it('bridges a Deezer album by its URL relation and merges it into the row that has the MBID', async () => {
    const [existing] = await db.execute<{ id: string }>(sql`select id from albums where mbid = ${okComputer}`)
    const { albumId: stub } = await albumStub({ title: 'OK Computer', artist: 'Radiohead', deezerId: 14879699 })
    await albumDetailRun(stub)

    expect(http.requests.some((url) => url.includes('/ws/2/url?'))).toBe(true)
    expect((await albumRow(stub)).mergedIntoId).toBe(existing!.id)
    expect(await deezerIdsOf('album', existing!.id)).toEqual(['14879699'])
    // The Deezer page's tracks are matched to the recordings by ISRC.
    const [airbag] = await db.select({ id: recordings.id }).from(recordings).where(sql`${recordings.isrcs} @> array['GBAYE9701274']`)
    expect(await deezerIdsOf('recording', airbag!.id)).toEqual(['138539971'])
    // The page for the stub's id shows the album it became.
    expect((await albumDetail(context.userId, stub)).id).toBe(existing!.id)
  })

  it('bridges by UPC when MusicBrainz has no link to the Deezer page, adopting the MBID in place', async () => {
    const { albumId } = await albumStub({ title: 'Antisocialites', artist: 'Alvvays', deezerId: 369493327 })
    await albumDetailRun(albumId)
    const { album, tracks } = await canonical(albumId)
    expect(album).toMatchObject({ mbid: '1f0a3090-ae8c-4fbd-9b70-b4371961ef11', detailLevel: 2, mergedIntoId: null })
    expect(tracks.length).toBeGreaterThan(8)
    expect(http.requests.some((url) => url.includes('barcode'))).toBe(true)
    expect(http.requests.some((url) => url.includes('/release-group?query'))).toBe(false)
  })

  it('bridges by a strict title and artist search when neither link nor barcode is known', async () => {
    const { albumId } = await albumStub({ title: 'Miraculé', artist: 'Niro', deezerId: 7887699 })
    await albumDetailRun(albumId)
    const { album, tracks } = await canonical(albumId)
    expect(album).toMatchObject({ mbid: 'a6ccb4c7-5d38-4140-8482-14fc4db43480', detailLevel: 2 })
    expect(tracks.length).toBeGreaterThan(5)
    expect(http.requests.some((url) => url.includes('/release-group?query'))).toBe(true)
  })

  it('builds the track list from Deezer when nothing matches, and retries the bridge a day later', async () => {
    const { albumId } = await albumStub({ title: 'Discovery', artist: 'Data Punk', deezerId: 74901252 })
    await albumDetailRun(albumId)
    const { album, release, tracks } = await canonical(albumId)
    expect(album).toMatchObject({ mbid: null, detailLevel: 1 })
    expect(release).toMatchObject({ mbid: null, format: 'Digital Media' })
    expect(tracks.length).toBeGreaterThan(0)
    expect(tracks.every((track) => track.mbid === null && track.isrcs.length === 1)).toBe(true)
    const page = await albumDetail(context.userId, albumId)
    expect(page.discs.flatMap((disc) => disc.tracks).map((track) => track.title)).toEqual(tracks.map((track) => track.title))

    http.requests.length = 0
    await albumDetailRun(albumId)
    expect(http.requests).toEqual([])

    // A day later the bridge is tried again (answered from the cache here), and the rows are reused.
    await db.execute(sql`update albums set fetched_at = now() - interval '2 days' where id = ${albumId}`)
    const before = await db.select({ id: recordings.id }).from(recordings)
    await albumDetailRun(albumId)
    expect((await albumRow(albumId)).fetchedAt!.getTime()).toBeGreaterThan(Date.now() - 60_000)
    expect(await db.select({ id: recordings.id }).from(recordings)).toHaveLength(before.length)
    expect(await db.select().from(releases).where(eq(releases.albumId, albumId))).toHaveLength(1)
  })

  it('asks nothing when every source is off', async () => {
    await db.delete(httpCache)
    await updateServerSettings({ musicBrainzEnabled: false, deezerEnabled: false, coverArtArchiveEnabled: false })
    const { albumId } = await albumStub({ title: 'In Rainbows', artist: 'Radiohead', deezerId: 14880659 })
    const { albumId: byMbid } = await albumStub({ title: 'Kid A', artist: 'Radiohead', mbid: '0e7d5b1e-2222-4000-8000-000000000000' })
    await ensureAlbumDetail(albumId)
    await ensureAlbumDetail(byMbid)
    expect(http.requests).toEqual([])
    expect(await db.select().from(releases).where(eq(releases.albumId, albumId))).toEqual([])
    await updateServerSettings({ musicBrainzEnabled: true, deezerEnabled: true, coverArtArchiveEnabled: true })
  })
})

describe('album detail with owned music and merges', () => {
  const { http } = useAlbumTests()

  it('never replaces the MusicBrainz edition the files of an album are on', async () => {
    const owned = await createAlbum({ title: 'OK Computer', mbid: okComputer, owned: true, tracks: [{ title: 'Airbag' }] })
    // The edition matching chose, which need not be the one chooseCanonicalRelease picks.
    await db.update(releases).set({ mbid: '0a1b2c3d-0000-4000-8000-000000000001' }).where(eq(releases.id, owned.releaseId))
    await hydrateAlbum(owned.albumId)
    const album = await albumRow(owned.albumId)
    expect(album).toMatchObject({ canonicalReleaseId: owned.releaseId, detailLevel: 2 })
    expect(album.genres.length).toBeGreaterThan(0)
    expect(http.requests.some((url) => url.includes('/ws/2/release/'))).toBe(false)
  })

  it('follows a MusicBrainz merge: a row with the old release-group id is merged into the one with the new id', async () => {
    const [current] = await db.execute<{ id: string }>(sql`select id from albums where mbid = ${okComputer}`)
    const { albumId: old } = await albumStub({ title: 'OK Computer', artist: 'Radiohead', mbid: mergedOkComputer })
    await ensureAlbumDetail(old)
    expect((await albumRow(old)).mergedIntoId).toBe(current!.id)
  })

  it('takes the new id when no row has it yet', async () => {
    await db.execute(sql`update albums set mbid = null where mbid in (${okComputer}, ${mergedOkComputer})`)
    const { albumId: old } = await albumStub({ title: 'OK Computer', artist: 'Radiohead', mbid: mergedOkComputer, year: 1997 })
    await hydrateAlbum(old)
    expect(await albumRow(old)).toMatchObject({ mbid: okComputer, mergedIntoId: null, detailLevel: 2 })
    expect((await canonical(old)).tracks).toHaveLength(12)
  })
})

describe('album detail bounds', () => {
  const context = useAlbumTests()
  const { http } = context

  it('runs once for concurrent callers', async () => {
    const { albumId } = await albumStub({ title: 'Antisocialites', artist: 'Alvvays', mbid: '1f0a3090-ae8c-4fbd-9b70-b4371961ef11' })
    await Promise.all([ensureAlbumDetail(albumId), ensureAlbumDetail(albumId), albumDetail(context.userId, albumId)])
    expect(http.requests.length).toBeGreaterThan(0)
    expect(new Set(http.requests).size).toBe(http.requests.length)
    expect((await albumRow(albumId)).detailLevel).toBe(2)
  })

  it('renders what is known when the budget runs out, finishes in the background and queues a safety net', async () => {
    const { albumId } = await albumStub({ title: 'Miraculé', artist: 'Niro', mbid: 'a6ccb4c7-5d38-4140-8482-14fc4db43480' })
    const fixtures = globalThis.fetch
    let open: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      open = resolve
    })
    vi.stubGlobal('fetch', async (...args: Parameters<typeof fetch>) => {
      await gate
      return fixtures(...args)
    })
    setDetailBudget(300)

    const started = Date.now()
    const page = await albumDetail(context.userId, albumId)
    expect(Date.now() - started).toBeLessThan(2000)
    expect(page.discs).toEqual([])
    // Not final: clients show it as loading and refetch on the invalidation.
    expect(page.detailPending).toBe(true)
    const [job] = await db.execute<{ startAfter: Date }>(sql`
      select start_after as "startAfter" from pgboss.job where name = 'enrichment.album' and singleton_key = ${albumId}`)
    expect(new Date(job!.startAfter).getTime()).toBeGreaterThan(Date.now())

    // A second visit while the run is still going does not wait out the budget again.
    const again = Date.now()
    expect((await albumDetail(context.userId, albumId)).detailPending).toBe(true)
    expect(Date.now() - again).toBeLessThan(200)

    open()
    await albumDetailRun(albumId)
    expect((await albumRow(albumId)).detailLevel).toBe(2)
    const done = await albumDetail(context.userId, albumId)
    expect(done.discs[0]!.tracks.length).toBeGreaterThan(5)
    expect(done.detailPending).toBeUndefined()
  })

  it('shows the Deezer track list while MusicBrainz is still answering', async () => {
    const { albumId } = await albumStub({ title: 'OK Computer', artist: 'Radiohead', mbid: okComputer, deezerId: 14879699 })
    const fixtures = globalThis.fetch
    let open: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      open = resolve
    })
    vi.stubGlobal('fetch', async (...args: Parameters<typeof fetch>) => {
      if (String(args[0]).includes('musicbrainz.org')) await gate
      return fixtures(...args)
    })
    setDetailBudget(1500)

    const started = Date.now()
    const page = await albumDetail(context.userId, albumId)
    expect(Date.now() - started).toBeLessThan(1000)
    expect(page.detailPending).toBe(true)
    expect(page.discs[0]!.tracks.map((track) => track.title).slice(0, 2)).toEqual(['Airbag', 'Paranoid Android'])

    open()
    await albumDetailRun(albumId)
    const { release, tracks } = await canonical(albumId)
    expect(release.mbid).toBe(okComputerCanonical)
    expect(tracks).toHaveLength(12)
    // The Deezer rows became the MusicBrainz ones: one edition, ids that still resolve.
    expect(await db.select({ id: releases.id }).from(releases).where(eq(releases.albumId, albumId))).toHaveLength(1)
    const pageTrack = page.discs[0]!.tracks[0]!
    const [airbag] = await db.select({ mbid: recordings.mbid, into: recordings.mergedIntoId }).from(recordings).where(eq(recordings.id, pageTrack.id))
    expect(airbag!.mbid ?? airbag!.into).toBeTruthy()
  })

  it('does not throw when a provider is down', async () => {
    const { albumId } = await albumStub({ title: 'Kid A', artist: 'Radiohead', mbid: '0e7d5b1e-1111-4000-8000-000000000000' })
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('fetch failed')
    })
    await expect(ensureAlbumDetail(albumId)).resolves.toBe(true)
    expect(await albumDetail(context.userId, albumId)).toMatchObject({ id: albumId, discs: [] })
    expect((await albumRow(albumId)).detailLevel).toBe(0)
  })
})

describe('album detail folds stand-in recordings into the release', () => {
  const context = useAlbumTests()

  /** A recording as Deezer's top tracks store it: no MBID, no ISRC, Deezer's rounded length. */
  async function topTrackStub(title: string, artistId: string, durationMs: number) {
    const id = newId()
    await db.insert(recordings).values({ id, title, artistCredit: 'Radiohead', primaryArtistId: artistId, durationMs, titleKey: matchKey(title), matchKey: creditKey('Radiohead', title) })
    return id
  }

  async function trackRows(albumId: string) {
    const page = await albumDetail(context.userId, albumId)
    return page.discs.flatMap((disc) => disc.tracks)
  }

  it('merges a top-track stub that owns a file filed under the album into its MusicBrainz track', async () => {
    const artistId = await artistStub({ name: 'Radiohead', mbid: radiohead })
    const { albumId } = await albumStub({ title: 'OK Computer', artist: 'Radiohead', artistId, mbid: okComputer })
    await ensureAlbumDetail(albumId)
    // Played from the artist page, fetched, and filed under the complete album.
    const stub = await topTrackStub('Karma Police', artistId, 262_000)
    const root = await createLibraryRoot()
    await createFile({ rootId: root.id, recordingId: stub, albumId })
    await ensureAlbumDetail(albumId)

    const [row] = await db.select({ mergedIntoId: recordings.mergedIntoId }).from(recordings).where(eq(recordings.id, stub))
    expect(row!.mergedIntoId).not.toBeNull()
    const tracks = await trackRows(albumId)
    expect(tracks).toHaveLength(12)
    expect(tracks.find((track) => track.title === 'Karma Police')).toMatchObject({ position: 6, availability: 'server' })
    expect((await albumDetail(context.userId, albumId)).availability).toBe('partial')
  })

  it('merges a loose top-track stub of the album artist, and leaves other versions alone', async () => {
    const [artist] = await db.execute<{ id: string }>(sql`select id from artists where mbid = ${radiohead}`)
    const [album] = await db.execute<{ id: string }>(sql`select id from albums where mbid = ${okComputer}`)
    const stub = await topTrackStub('No Surprises', artist!.id, 229_000)
    const live = await topTrackStub('Lucky (Live)', artist!.id, 259_000)
    const longer = await topTrackStub('Let Down', artist!.id, 340_000)
    // Top tracks stored before the album's release is written again.
    await hydrateAlbum(album!.id, { force: true })
    const merged = async (id: string) => (await db.select({ into: recordings.mergedIntoId }).from(recordings).where(eq(recordings.id, id)))[0]!.into
    expect(await merged(stub)).not.toBeNull()
    expect(await merged(live)).toBeNull()
    expect(await merged(longer)).toBeNull()
  })
})

describe('album detail for an owned album without a MusicBrainz edition', () => {
  const context = useAlbumTests()

  it('takes the canonical release from MusicBrainz and fits the files to its tracks', async () => {
    const artist = await createArtist({ name: 'Radiohead', mbid: radiohead })
    // A one-track local album that was merged into the release group's row later.
    const owned = await createAlbum({ title: 'OK Computer', artist, mbid: okComputer, owned: true, tracks: [{ title: 'Airbag', durationMs: 284_000 }] })
    await db.update(albums).set({ detailLevel: 1 }).where(eq(albums.id, owned.albumId))
    await ensureAlbumDetail(owned.albumId)

    const { release, tracks } = await canonical(owned.albumId)
    expect(release.mbid).toBe(okComputerCanonical)
    expect(tracks).toHaveLength(12)
    const page = await albumDetail(context.userId, owned.albumId)
    expect(page).toMatchObject({ trackCount: 12, ownedTrackCount: 1, availability: 'partial' })
    expect(page.discs[0]!.tracks[0]).toMatchObject({ title: 'Airbag', availability: 'server', position: 1 })
  })
})
