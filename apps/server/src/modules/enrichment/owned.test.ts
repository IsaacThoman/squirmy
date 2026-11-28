import { Lyrics } from '@squirmy/contracts'
import { and, eq, inArray, sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { buildApp } from '../../app.js'
import { db } from '../../database/client.js'
import { albumArtists, albums, artists, assets, externalIds, likes, lyrics, recordings, releases } from '../../database/schema.js'
import { startJobs } from '../../jobs/index.js'
import { newId, newPublicId } from '../../lib/ids.js'
import { updateServerSettings } from '../../lib/settings.js'
import { creditKey, matchKey } from '../../lib/text.js'
import { body, errorCode, signIn } from '../../test/api.js'
import { useTestDatabase } from '../../test/database.js'
import { createAlbum, createArtist, createUser } from '../../test/factories.js'
import { useHttpFixtures } from '../../test/http.js'
import { demoAlbums } from '../../test/matching.js'
import { home } from '../catalog/home.js'
import { fetchLyrics } from './lyrics.js'
import { enrichAlbum } from './owned.js'
import { newReleaseAlbumIds, refreshNewReleases } from './releases.js'
import { setDetailBudget } from './runner.js'
import { sweep } from './sweep.js'
import { albumRow } from '../../test/enrichment-stubs.js'

const radiohead = 'a74b1b7f-71a5-4011-9441-d0b5e4122711'
const okComputer = 'b1392450-e666-3926-a536-22c65f834433'
const okComputerCd = '52709206-8816-3c12-9ff6-f957f2f1eecf'

async function imageAsset(side: number) {
  const [row] = await db.insert(assets).values({
    id: newPublicId(), kind: 'embedded', source: 'file:test', sha256: newId(), mime: 'image/jpeg', width: side, height: side, bytes: 1,
    color: '#000000', thumbhash: 'AAAA', storagePath: 'test',
  }).returning()
  return row!
}

async function deezerIds(entityType: 'artist' | 'album' | 'recording', entityId: string) {
  return (await db.select({ id: externalIds.externalId }).from(externalIds)
    .where(and(eq(externalIds.provider, 'deezer'), eq(externalIds.entityType, entityType), eq(externalIds.entityId, entityId)))).map((row) => row.id)
}

async function queued(name: string) {
  return (await db.execute<{ key: string }>(sql`select singleton_key as key from pgboss.job where name = ${name} and state = 'created'`)).map((row) => row.key)
}

describe('owned music enrichment', () => {
  useTestDatabase()
  const http = useHttpFixtures('enrichment', 'musicbrainz', 'deezer', 'coverart', 'wikidata', 'lrclib')
  let app: FastifyInstance
  let user: Awaited<ReturnType<typeof signIn>>
  let owned: Awaited<ReturnType<typeof createAlbum>>

  beforeAll(async () => {
    await startJobs({ work: false })
    app = await buildApp()
    user = await signIn({ settings: { libraryIncludesServerMusic: true } })
    const artist = await createArtist({ name: 'Radiohead', mbid: radiohead })
    owned = await createAlbum({
      title: 'OK Computer', artist, mbid: okComputer, owned: true,
      tracks: demoAlbums.okComputer.tracks.map((track) => ({ title: track.title, durationMs: track.title === 'Karma Police' ? 264_000 : track.durationMs })),
    })
    // Matched: the album detail is complete and the canonical release is the CD.
    await db.update(albums).set({ detailLevel: 2, fetchedAt: new Date() }).where(eq(albums.id, owned.albumId))
    await db.update(releases).set({ mbid: okComputerCd, barcode: '634904078164' }).where(eq(releases.id, owned.releaseId))
  })
  beforeEach(() => setDetailBudget(60_000))
  afterAll(async () => {
    setDetailBudget(4000)
    await app.close()
  })

  it('keeps large embedded art and records Deezer ids, a description and lyrics jobs', async () => {
    const art = await imageAsset(600)
    await db.update(albums).set({ artworkAssetId: art.id }).where(eq(albums.id, owned.albumId))
    await enrichAlbum(owned.albumId)

    const album = await albumRow(owned.albumId)
    expect(album.artworkAssetId).toBe(art.id)
    expect(http.requests.some((url) => url.includes('coverartarchive.org'))).toBe(false)
    expect(album.enrichedAt).not.toBeNull()
    expect(album.description).toMatch(/OK Computer/)
    expect(album.descriptionSource).toBe('wikipedia')
    // Found on Deezer by UPC: the album, its artist and every track by position and title.
    expect(await deezerIds('album', owned.albumId)).toEqual(['14879699'])
    expect(await deezerIds('artist', owned.artist.id)).toEqual(['399'])
    for (const track of owned.tracks) expect(await deezerIds('recording', track.recordingId)).toHaveLength(1)
    expect((await queued('enrichment.lyrics')).sort()).toEqual(owned.tracks.map((track) => track.recordingId).sort())
  })

  it('finds the Deezer album through ISRCs when the edition barcode is not on Deezer', async () => {
    await db.delete(externalIds).where(eq(externalIds.provider, 'deezer'))
    await db.update(releases).set({ barcode: '999999999999' }).where(eq(releases.id, owned.releaseId))
    await db.update(recordings).set({ isrcs: ['GBAYE9701274'] }).where(eq(recordings.id, owned.tracks[0]!.recordingId))
    await db.update(albums).set({ enrichedAt: null }).where(eq(albums.id, owned.albumId))
    await enrichAlbum(owned.albumId)
    expect(http.requests).toEqual(expect.arrayContaining(['GET https://api.deezer.com/album/upc:999999999999', 'GET https://api.deezer.com/track/isrc:GBAYE9701274']))
    expect(await deezerIds('album', owned.albumId)).toEqual(['14879699'])
    for (const track of owned.tracks) expect(await deezerIds('recording', track.recordingId)).toHaveLength(1)
    expect((await albumRow(owned.albumId)).enrichedAt).not.toBeNull()
  })

  it('replaces small art with the Cover Art Archive front, stored', async () => {
    const small = await imageAsset(300)
    await db.update(albums).set({ artworkAssetId: small.id, enrichedAt: null }).where(eq(albums.id, owned.albumId))
    await enrichAlbum(owned.albumId)

    const [cover] = await db.select().from(assets).where(eq(assets.id, (await albumRow(owned.albumId)).artworkAssetId!))
    expect(cover).toMatchObject({ kind: 'cover', status: 'ready', width: 700, height: 700, remoteUrl: null })
    expect(cover!.source).toMatch(/^https:\/\/coverartarchive\.org\/release\/52709206/)
  })

  it('fetches lyrics on demand, stores a marker when there are none, and leaves local lyrics alone', async () => {
    const karma = owned.tracks.find((track) => track.title === 'Karma Police')!
    const found = body(await app.inject({ url: `/api/v1/tracks/${karma.recordingId}/lyrics`, headers: user.headers }), Lyrics)
    expect(found).toMatchObject({ trackId: karma.recordingId, source: 'lrclib' })
    expect(found.synced).toMatch(/^\[\d\d:\d\d\.\d\d\]/)

    const artistId = (await createArtist({ name: 'Squirmy Fixture Band' })).id
    const toneId = newId()
    await db.insert(recordings).values({
      id: toneId, title: 'Quiet Test Tone', artistCredit: 'Squirmy Fixture Band', primaryArtistId: artistId, durationMs: 2000,
      titleKey: matchKey('Quiet Test Tone'), matchKey: creditKey('Squirmy Fixture Band', 'Quiet Test Tone'),
    })
    expect(errorCode(await app.inject({ url: `/api/v1/tracks/${toneId}/lyrics`, headers: user.headers }), 404)).toBe('lyrics_not_found')
    const [marker] = await db.select().from(lyrics).where(eq(lyrics.recordingId, toneId))
    expect(marker).toMatchObject({ source: 'none', synced: null, plain: null })

    http.requests.length = 0
    await fetchLyrics(toneId)
    expect(http.requests).toEqual([])
    await db.update(lyrics).set({ fetchedAt: new Date(Date.now() - 31 * 86_400_000) }).where(eq(lyrics.recordingId, toneId))
    await fetchLyrics(toneId)
    // Looked up again (LRCLIB's answer comes from the response cache here).
    expect((await db.select().from(lyrics).where(eq(lyrics.recordingId, toneId)))[0]!.fetchedAt.getTime()).toBeGreaterThan(Date.now() - 60_000)

    const sidecar = owned.tracks[0]!.recordingId
    await db.insert(lyrics).values({ recordingId: sidecar, plain: 'From the file', source: 'sidecar' })
    http.requests.length = 0
    await fetchLyrics(sidecar)
    expect(http.requests).toEqual([])
    expect((await db.select().from(lyrics).where(eq(lyrics.recordingId, sidecar)))[0]).toMatchObject({ source: 'sidecar', plain: 'From the file' })
  })

  it('adds new releases by library artists and shows recent ones the library lacks on Home', async () => {
    expect(await refreshNewReleases()).toBeGreaterThan(50)
    expect(await refreshNewReleases()).toBe(0)

    const day = (offset: number) => new Date(Date.now() - offset * 86_400_000).toISOString().slice(0, 10)
    const addAlbum = async (title: string, releaseDate: string) => {
      const id = newId()
      await db.insert(albums).values({
        id, title, artistCredit: 'Radiohead', primaryArtistId: owned.artist.id, releaseDate, year: Number(releaseDate.slice(0, 4)),
        titleKey: matchKey(title), matchKey: creditKey('Radiohead', title), detailLevel: 1,
      })
      await db.insert(albumArtists).values({ albumId: id, position: 0, artistId: owned.artist.id, creditedName: 'Radiohead' })
      return id
    }
    const fresh = await addAlbum('Brand New', day(10))
    await addAlbum('Last Spring', day(200))
    await addAlbum('Next Year', day(-300))
    await addAlbum('Only a Year', day(10).slice(0, 4))
    const ownedRecent = await createAlbum({ title: 'Owned Recent', artist: owned.artist, owned: true })
    await db.update(albums).set({ releaseDate: day(5) }).where(eq(albums.id, ownedRecent.albumId))

    expect(await newReleaseAlbumIds(user.id, 20)).toEqual([fresh])
    const section = (await home(user.id)).sections.find((one) => one.id === 'new-releases')
    expect(section).toMatchObject({ kind: 'albums', title: 'New releases' })
    expect(section?.kind === 'albums' && section.albums.map((album) => album.id)).toEqual([fresh])
  })

  it("draws new releases from each user's own artists, and leaves cover acts out", async () => {
    const other = await createUser()
    const day = (offset: number) => new Date(Date.now() - offset * 86_400_000).toISOString().slice(0, 10)
    const recentBy = async (artist: { id: string; name: string }, title: string) => {
      const album = await createAlbum({ title, artist })
      await db.update(albums).set({ releaseDate: day(3) }).where(eq(albums.id, album.albumId))
      return album.albumId
    }
    // Played, so cached: fetched music makes no one's artist (live: nine karaoke volumes on Home).
    const karaoke = await createArtist({ name: 'Party Tyme Karaoke' })
    const sampled = await createAlbum({ title: 'Sampled', artist: karaoke, owned: true, source: 'provider:00000000-0000-7000-8000-000000000000' })
    // Enriched already, so the sweep test that follows finds only its own work.
    await db.update(albums).set({ enrichedAt: new Date() }).where(eq(albums.id, sampled.albumId))
    const karaokeRelease = await recentBy(karaoke, 'Karaoke Hits Vol. 9')
    // Hearted by the other user only: theirs, not this user's.
    const followed = await createArtist({ name: 'Followed Act' })
    await db.insert(likes).values({ userId: other.id, entityType: 'artist', entityId: followed.id })
    const followedRelease = await recentBy(followed, 'Followed Album')
    // A cover act's release under an artist the user has is not their new music.
    const tribute = await recentBy(owned.artist, 'A Tribute to the Library Band')
    const quartet = await recentBy(owned.artist, 'String Quartet Performs the Library Band')

    const mine = await newReleaseAlbumIds(user.id, 200)
    expect(mine).not.toContain(karaokeRelease)
    expect(mine).not.toContain(followedRelease)
    expect(mine).not.toContain(tribute)
    expect(mine).not.toContain(quartet)
    expect(await newReleaseAlbumIds(other.id, 200)).toContain(followedRelease)
    // Saving the album takes it out of the feed: the library has it now.
    await db.insert(likes).values({ userId: other.id, entityType: 'album', entityId: followedRelease })
    expect(await newReleaseAlbumIds(other.id, 200)).not.toContain(followedRelease)
  })

  it('uses the collection preference for both artist membership and releases already in the library', async () => {
    const savesOnly = await createUser({ settings: { libraryIncludesServerMusic: false } })
    const fresh = await createAlbum({ title: 'Feed Scope New', artist: owned.artist })
    const collected = await createAlbum({ title: 'Feed Scope Collected', artist: owned.artist, owned: true })
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10)
    await db.update(albums).set({ releaseDate: yesterday, enrichedAt: new Date() })
      .where(inArray(albums.id, [fresh.albumId, collected.albumId]))

    const optedIn = await newReleaseAlbumIds(user.id, 200)
    expect(optedIn).toContain(fresh.albumId)
    expect(optedIn).not.toContain(collected.albumId)
    expect(await newReleaseAlbumIds(savesOnly.id, 200)).toEqual([])
    await db.insert(likes).values({ userId: savesOnly.id, entityType: 'album', entityId: owned.albumId })
    expect(await newReleaseAlbumIds(savesOnly.id, 200)).toEqual(expect.arrayContaining([fresh.albumId, collected.albumId]))
    await db.insert(likes).values({ userId: savesOnly.id, entityType: 'album', entityId: collected.albumId })
    expect(await newReleaseAlbumIds(savesOnly.id, 200)).not.toContain(collected.albumId)
  })

  it('leaves Various Artists out of new releases: owning a compilation adds no one\'s discography', async () => {
    // 2026-11-22: an owned compilation made Various Artists a library artist, its
    // discography brought in some 266,000 compilations and Home listed them.
    const various = await createArtist({ name: 'Various Artists', mbid: '89ad4ac3-39f7-470e-963a-56509c546377' })
    const compilation = await createAlbum({ title: 'Owned Compilation', artist: various, type: 'compilation', owned: true })
    // Enriched already, so the sweep test that follows finds only its own work.
    await db.update(albums).set({ enrichedAt: new Date() }).where(eq(albums.id, compilation.albumId))
    await db.update(artists).set({ detailLevel: 2, fetchedAt: new Date() }).where(eq(artists.id, various.id))
    const recent = await createAlbum({ title: 'Some Compilation', artist: various, type: 'compilation' })
    await db.update(albums).set({ releaseDate: new Date(Date.now() - 3 * 86_400_000).toISOString().slice(0, 10) }).where(eq(albums.id, recent.albumId))

    http.requests.length = 0
    await refreshNewReleases()
    expect(http.requests.filter((url) => url.includes('89ad4ac3-39f7-470e-963a-56509c546377'))).toEqual([])
    expect(await newReleaseAlbumIds(user.id, 200)).not.toContain(recent.albumId)
  })

  it('sweeps owned music that was never enriched', async () => {
    await db.execute(sql`delete from pgboss.job where name like 'enrichment.%'`)
    const other = await createAlbum({ title: 'Never Enriched', owned: true })
    await db.update(albums).set({ enrichedAt: new Date() }).where(eq(albums.title, 'Owned Recent'))
    await sweep()
    expect(await queued('enrichment.album')).toEqual([other.albumId])
    // Radiohead has an MBID and is below detail level 2; the new album's artist has nothing to look up.
    expect(await queued('enrichment.artist')).toEqual([owned.artist.id])
    expect(await queued('enrichment.lyrics')).toEqual(expect.arrayContaining(other.tracks.map((track) => track.recordingId)))
    expect(await queued('enrichment.lyrics')).not.toContain(owned.tracks.find((track) => track.title === 'Karma Police')!.recordingId)
  })

  it('asks nothing when every source is off', async () => {
    await updateServerSettings({ musicBrainzEnabled: false, deezerEnabled: false, coverArtArchiveEnabled: false, wikidataEnabled: false, lrclibEnabled: false })
    const another = await createAlbum({ title: 'Switched Off', mbid: '11111111-2222-4333-8444-000000000002', owned: true })
    http.requests.length = 0
    await enrichAlbum(another.albumId)
    await fetchLyrics(another.tracks[0]!.recordingId)
    expect(http.requests).toEqual([])
    expect(await db.select().from(lyrics).where(eq(lyrics.recordingId, another.tracks[0]!.recordingId))).toEqual([])
    await updateServerSettings({ musicBrainzEnabled: true, deezerEnabled: true, coverArtArchiveEnabled: true, wikidataEnabled: true, lrclibEnabled: true })
  })

  it('revisits enriched music, a sweep at a time, when a source is switched on', async () => {
    const admin = await signIn({ role: 'admin' })
    const patch = (payload: Record<string, unknown>) => app.inject({ method: 'PATCH', url: '/api/v1/admin/settings', headers: admin.headers, payload })
    const artist = await createArtist({ name: 'Enriched Act', mbid: '11111111-2222-4333-8444-000000000004' })
    const enriched = await createAlbum({ title: 'Enriched Before', artist, mbid: '11111111-2222-4333-8444-000000000003', owned: true })
    const unowned = await createAlbum({ title: 'Browsed Only' })
    await db.update(albums).set({ enrichedAt: new Date() }).where(inArray(albums.id, [enriched.albumId, unowned.albumId]))
    await db.update(artists).set({ detailLevel: 2, fetchedAt: new Date() }).where(inArray(artists.id, [enriched.artist.id, unowned.artist.id]))
    const state = async () => ({
      album: (await db.select({ enrichedAt: albums.enrichedAt }).from(albums).where(eq(albums.id, enriched.albumId)))[0]!.enrichedAt,
      artist: (await db.select({ level: artists.detailLevel }).from(artists).where(eq(artists.id, enriched.artist.id)))[0]!.level,
      untouched: [
        (await db.select({ enrichedAt: albums.enrichedAt }).from(albums).where(eq(albums.id, unowned.albumId)))[0]!.enrichedAt,
        (await db.select({ level: artists.detailLevel }).from(artists).where(eq(artists.id, unowned.artist.id)))[0]!.level,
      ],
    })

    // Changing something else, or switching a source off, leaves enrichment alone.
    expect((await patch({ serverName: 'Elsewhere', lrclibEnabled: false })).statusCode).toBe(200)
    expect(await state()).toMatchObject({ album: expect.any(Date), artist: 2 })

    // A fanart.tv key improves artist images only.
    expect((await patch({ fanartKey: 'operator-key' })).statusCode).toBe(200)
    expect(await state()).toMatchObject({ album: expect.any(Date), artist: 1, untouched: [expect.any(Date), 2] })

    // Wikidata coming back on improves album descriptions too.
    await patch({ wikidataEnabled: false })
    expect((await patch({ wikidataEnabled: true, lrclibEnabled: true })).statusCode).toBe(200)
    expect(await state()).toMatchObject({ album: null, artist: 1, untouched: [expect.any(Date), 2] })

    await db.execute(sql`delete from pgboss.job where name like 'enrichment.%'`)
    await sweep()
    expect(await queued('enrichment.album')).toContain(enriched.albumId)
    expect(await queued('enrichment.artist')).toContain(enriched.artist.id)
    // LRCLIB was off: nothing was looked up, so the sweep finds the tracks without lyrics.
    expect(await queued('enrichment.lyrics')).toEqual(expect.arrayContaining(enriched.tracks.map((track) => track.recordingId)))
    await patch({ fanartKey: null })
  })

})
