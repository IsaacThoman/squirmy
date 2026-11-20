import { and, eq, isNull, sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '../../database/client.js'
import { albumArtists, albums, assets, externalIds, recordings } from '../../database/schema.js'
import { updateServerSettings } from '../../lib/settings.js'
import { useTestDatabase } from '../../test/database.js'
import { createUser } from '../../test/factories.js'
import { useHttpFixtures } from '../../test/http.js'
import { artistDetail } from '../catalog/pages.js'
import { hydrateArtist } from './artist.js'
import { ensureArtistDetail } from './detail.js'
import { setDetailBudget } from './runner.js'
import { artistRow, artistStub } from './test-stubs.js'

const radiohead = 'a74b1b7f-71a5-4011-9441-d0b5e4122711'
const okComputer = 'b1392450-e666-3926-a536-22c65f834433'

async function deezerIds(entityId: string) {
  return (await db.select({ id: externalIds.externalId }).from(externalIds)
    .where(and(eq(externalIds.provider, 'deezer'), eq(externalIds.entityType, 'artist'), eq(externalIds.entityId, entityId)))
    .orderBy(externalIds.externalId)).map((row) => row.id)
}

async function counts() {
  const [row] = await db.execute<{ albums: number; credits: number; assets: number; recordings: number }>(sql`
    select (select count(*) from albums)::int as albums, (select count(*) from album_artists)::int as credits,
      (select count(*) from assets)::int as assets, (select count(*) from recordings)::int as recordings`)
  return row!
}

describe('artist detail', () => {
  useTestDatabase()
  const http = useHttpFixtures('enrichment', 'musicbrainz', 'deezer', 'wikidata', 'fanart', 'listenbrainz')
  let userId = ''

  beforeAll(async () => {
    userId = (await createUser()).id
  })
  // Recording waits out MusicBrainz's rate limit.
  beforeEach(() => setDetailBudget(60_000))
  afterAll(() => setDetailBudget(4000))

  it('bridges a Deezer artist by URL relation into the MusicBrainz row and fills in profile, discography, image, bio and top tracks', async () => {
    const existing = await artistStub({ name: 'Radiohead', mbid: radiohead })
    const stub = await artistStub({ name: 'Radiohead', deezerId: 399 })
    await ensureArtistDetail(stub)

    expect((await artistRow(stub)).mergedIntoId).toBe(existing)
    const artist = await artistRow(existing)
    expect(artist).toMatchObject({ kind: 'Group', country: 'GB', detailLevel: 2, bioSource: 'wikipedia' })
    expect(artist.genres).toContain('alternative rock')
    expect(artist.bio).toMatch(/Radiohead/)
    expect(artist.bioUrl).toMatch(/^https:\/\/en\.wikipedia\.org\//)
    // Both Deezer pages MusicBrainz links; the one with more fans supplies the picture.
    expect(await deezerIds(existing)).toEqual(['323887691', '399'])
    const [image] = await db.select().from(assets).where(eq(assets.id, artist.imageAssetId!))
    expect(image).toMatchObject({ kind: 'artist', status: 'remote' })
    expect(image!.remoteUrl).toMatch(/^https:\/\/cdn-images\.dzcdn\.net\//)

    // The official discography, each album with a lazy Cover Art Archive cover.
    const discography = await db.select({ mbid: albums.mbid, type: albums.type, detailLevel: albums.detailLevel, cover: assets.remoteUrl })
      .from(albums).innerJoin(albumArtists, eq(albumArtists.albumId, albums.id)).leftJoin(assets, eq(assets.id, albums.artworkAssetId))
      .where(eq(albumArtists.artistId, existing))
    expect(discography.length).toBeGreaterThan(50)
    expect(discography.length).toBeLessThan(200)
    expect(discography.find((album) => album.mbid === okComputer)).toEqual({
      mbid: okComputer, type: 'album', detailLevel: 1, cover: `https://coverartarchive.org/release-group/${okComputer}/front-500`,
    })
    expect(discography.every((album) => album.cover?.startsWith('https://coverartarchive.org/release-group/'))).toBe(true)

    // Deezer's top tracks, as stubs with a 0..1 popularity the page ranks by.
    const popular = await db.select({ title: recordings.title, popularity: recordings.popularity }).from(recordings)
      .where(and(eq(recordings.primaryArtistId, existing), sql`${recordings.popularity} is not null`)).orderBy(sql`${recordings.popularity} desc`)
    expect(popular.length).toBeGreaterThan(10)
    expect(popular[0]!.popularity).toBe(1)
    expect(popular.every((track) => track.popularity! > 0 && track.popularity! <= 1)).toBe(true)

    const blur = await artistStub({ name: 'Blur' })
    const page = await artistDetail(userId, stub)
    expect(page).toMatchObject({ id: existing, name: 'Radiohead' })
    // Similar artists come from the radio module, limited to artists in the catalog.
    expect(page.similar.map((artist) => artist.id)).toContain(blur)
    expect(page.albums.length).toBe(discography.length)
    expect(page.topTracks[0]!.title).toBe(popular[0]!.title)
    expect(page.image).not.toBeNull()
  })

  it('upserts the discography idempotently', async () => {
    const [artist] = await db.execute<{ id: string }>(sql`select id from artists where mbid = ${radiohead}`)
    const before = await counts()
    http.requests.length = 0
    await ensureArtistDetail(artist!.id)
    expect(http.requests).toEqual([])
    await hydrateArtist(artist!.id, { force: true })
    expect(await counts()).toEqual(before)
  })

  it('ranks top tracks by ListenBrainz when a token is set', async () => {
    await updateServerSettings({ listenBrainzToken: 'operator-token' })
    const [artist] = await db.execute<{ id: string }>(sql`select id from artists where mbid = ${radiohead}`)
    await hydrateArtist(artist!.id, { force: true })
    const [top] = await db.select({ mbid: recordings.mbid, popularity: recordings.popularity }).from(recordings)
      .where(sql`${recordings.mbid} is not null and ${recordings.popularity} = 1`)
    expect(top?.mbid).toBeTruthy()
    expect(http.requests.some((url) => url.includes('listenbrainz.org'))).toBe(true)
    await updateServerSettings({ listenBrainzToken: null })
  })

  it('bridges a Deezer artist without a URL relation by an unambiguous exact-name search', async () => {
    const id = await artistStub({ name: 'Mira Valentin', deezerId: 49801012 })
    await ensureArtistDetail(id)
    expect(await artistRow(id)).toMatchObject({ mbid: '5bfe1046-9e57-4e4f-bc58-196b5a1a2e52', detailLevel: 2 })
    expect(http.requests.some((url) => url.includes('/ws/2/artist?query=Mira+Valentin'))).toBe(true)
  })

  it('builds an artist only Deezer knows from Deezer, and retries the bridge later', async () => {
    const id = await artistStub({ name: 'Relaxing Rain Sounds Hub', deezerId: 156692872 })
    await ensureArtistDetail(id)
    const artist = await artistRow(id)
    expect(artist).toMatchObject({ mbid: null, detailLevel: 1 })
    expect(artist.imageAssetId).not.toBeNull()
    const own = await db.select({ id: albums.id, title: albums.title, artworkAssetId: albums.artworkAssetId }).from(albums)
      .where(and(eq(albums.primaryArtistId, id), isNull(albums.mbid)))
    expect(own.length).toBeGreaterThan(0)
    expect(own.every((album) => album.artworkAssetId)).toBe(true)
    const [linked] = await db.select().from(externalIds).where(and(eq(externalIds.entityType, 'album'), eq(externalIds.entityId, own[0]!.id)))
    expect(linked).toMatchObject({ provider: 'deezer' })
    expect((await artistDetail(userId, id)).albums.map((album) => album.title)).toEqual(expect.arrayContaining(own.map((album) => album.title)))

    // Running again reuses the rows.
    await db.execute(sql`update artists set fetched_at = now() - interval '2 days' where id = ${id}`)
    await ensureArtistDetail(id)
    expect(await db.select({ id: albums.id }).from(albums).where(eq(albums.primaryArtistId, id))).toHaveLength(own.length)
  })

  it('takes fanart.tv images when Deezer has none to give', async () => {
    await updateServerSettings({ deezerEnabled: false, fanartKey: 'test-fanart-key' })
    const [artist] = await db.execute<{ id: string }>(sql`select id from artists where mbid = ${radiohead}`)
    await db.execute(sql`update artists set image_asset_id = null where id = ${artist!.id}`)
    await hydrateArtist(artist!.id, { force: true })
    const [image] = await db.select({ url: assets.remoteUrl }).from(assets).where(eq(assets.id, (await artistRow(artist!.id)).imageAssetId!))
    expect(image!.url).toMatch(/fanart\.tv/)
    await updateServerSettings({ deezerEnabled: true, fanartKey: null })
  })

  it('does not throw when a provider is down, and asks nothing when every source is off', async () => {
    const id = await artistStub({ name: 'Somebody', mbid: '11111111-2222-4333-8444-000000000001' })
    const fixtures = globalThis.fetch
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('fetch failed')
    })
    await expect(ensureArtistDetail(id)).resolves.toBeUndefined()
    expect((await artistDetail(userId, id)).albums).toEqual([])
    vi.stubGlobal('fetch', fixtures)

    await updateServerSettings({ musicBrainzEnabled: false, deezerEnabled: false, wikidataEnabled: false, coverArtArchiveEnabled: false })
    const deezerOnly = await artistStub({ name: 'Elsewhere', deezerId: 12345 })
    http.requests.length = 0
    await ensureArtistDetail(id)
    await ensureArtistDetail(deezerOnly)
    expect(http.requests).toEqual([])
    await updateServerSettings({ musicBrainzEnabled: true, deezerEnabled: true, wikidataEnabled: true, coverArtArchiveEnabled: true })
  })
})
