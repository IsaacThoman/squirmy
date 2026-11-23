import { and, eq, isNull, sql } from 'drizzle-orm'
import { ARTIST_SECTION_PREVIEW } from '@squirmy/contracts'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '../../database/client.js'
import { albumArtists, albums, artistTopTracks, artists, assets, externalIds, recordings } from '../../database/schema.js'
import { updateServerSettings } from '../../lib/settings.js'
import { useTestDatabase } from '../../test/database.js'
import { createUser } from '../../test/factories.js'
import { useHttpFixtures } from '../../test/http.js'
import { releaseKey } from '../search/keys.js'
import { artistDetail } from '../catalog/pages.js'
import { displayName, hydrateArtist } from './artist.js'
import { repairReleases } from './repair.js'
import { deezerDiscography, detachDeezerArtist } from './deezer-rows.js'
import { remoteImage } from '../artwork/index.js'
import { newPublicId } from '../../lib/ids.js'
import { artistDetailRun, ensureArtistDetail } from './detail.js'
import { setDetailBudget } from './runner.js'
import { artistRow, artistStub } from '../../test/enrichment-stubs.js'

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
    await artistDetailRun(stub)

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
    // Deezer's album, listed first, became the release group's row and kept its cover.
    expect(discography.find((album) => album.mbid === okComputer)).toEqual({
      mbid: okComputer, type: 'album', detailLevel: 1, cover: expect.stringMatching(/^https:\/\/cdn-images\.dzcdn\.net\//),
    })
    // Groups Deezer did not list have the Cover Art Archive's.
    expect(discography.every((album) => album.cover)).toBe(true)
    expect(discography.some((album) => album.cover?.startsWith('https://coverartarchive.org/release-group/'))).toBe(true)

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
    // Each release once: a row that shares its release and type with another is not listed.
    const release = (album: { title: string; type: string }) => `${releaseKey(album.title)}|${album.type}`
    expect(new Set(page.albums.map(release)).size).toBe(page.albums.length)
    const total = page.sections!.reduce((sum, section) => sum + section.total, 0)
    expect(total).toBeLessThanOrEqual(discography.length)
    expect(total).toBeGreaterThan(discography.length - 5)
    // Sections carry their first releases, and older clients get the same in albums.
    expect(page.sections!.every((section) => section.items.length === Math.min(section.total, ARTIST_SECTION_PREVIEW))).toBe(true)
    expect(page.albums.length).toBe(page.sections!.filter((section) => section.key !== 'appears_on').reduce((sum, section) => sum + section.items.length, 0))
    expect(page.releaseCount).toBe(page.sections!.filter((section) => section.key !== 'appears_on').reduce((sum, section) => sum + section.total, 0))
    expect(page.topTracks[0]!.title).toBe(popular[0]!.title)
    expect(page.image).not.toBeNull()
  })

  it('upserts the discography idempotently', async () => {
    const [artist] = await db.execute<{ id: string }>(sql`select id from artists where mbid = ${radiohead}`)
    const before = await counts()
    http.requests.length = 0
    await artistDetailRun(artist!.id)
    expect(http.requests).toEqual([])
    await hydrateArtist(artist!.id, { force: true })
    expect(await counts()).toEqual(before)
  })

  it('ranks top tracks by ListenBrainz when a token is set and Deezer has none', async () => {
    await updateServerSettings({ listenBrainzToken: 'operator-token', deezerEnabled: false })
    const [artist] = await db.execute<{ id: string }>(sql`select id from artists where mbid = ${radiohead}`)
    await hydrateArtist(artist!.id, { force: true })
    await updateServerSettings({ deezerEnabled: true })
    const listed = await db.select({ source: artistTopTracks.source }).from(artistTopTracks).where(eq(artistTopTracks.artistId, artist!.id))
    expect(listed.length).toBeGreaterThan(5)
    expect(listed.every((row) => row.source === 'listenbrainz')).toBe(true)
    const [top] = await db.select({ mbid: recordings.mbid, popularity: recordings.popularity }).from(recordings)
      .where(sql`${recordings.mbid} is not null and ${recordings.popularity} = 1`)
    expect(top?.mbid).toBeTruthy()
    expect(http.requests.some((url) => url.includes('listenbrainz.org'))).toBe(true)
    await updateServerSettings({ listenBrainzToken: null })
  })

  it('bridges a Deezer artist without a URL relation by an unambiguous exact-name search', async () => {
    const id = await artistStub({ name: 'Mira Valentin', deezerId: 49801012 })
    await artistDetailRun(id)
    expect(await artistRow(id)).toMatchObject({ mbid: '5bfe1046-9e57-4e4f-bc58-196b5a1a2e52', detailLevel: 2 })
    expect(http.requests.some((url) => url.includes('/ws/2/artist?query=Mira+Valentin'))).toBe(true)
  })

  it('builds an artist only Deezer knows from Deezer, and retries the bridge later', async () => {
    const id = await artistStub({ name: 'Relaxing Rain Sounds Hub', deezerId: 156692872 })
    await artistDetailRun(id)
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
    await artistDetailRun(id)
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
    await expect(ensureArtistDetail(id)).resolves.toBe(true)
    expect((await artistDetail(userId, id)).albums).toEqual([])
    vi.stubGlobal('fetch', fixtures)

    await updateServerSettings({ musicBrainzEnabled: false, deezerEnabled: false, wikidataEnabled: false, coverArtArchiveEnabled: false })
    const deezerOnly = await artistStub({ name: 'Elsewhere', deezerId: 12345 })
    http.requests.length = 0
    await artistDetailRun(id)
    await artistDetailRun(deezerOnly)
    expect(http.requests).toEqual([])
    await updateServerSettings({ musicBrainzEnabled: true, deezerEnabled: true, wikidataEnabled: true, coverArtArchiveEnabled: true })
  })

  it('fetches no discography or popular tracks for Various Artists', async () => {
    await updateServerSettings({ deezerEnabled: false, wikidataEnabled: false })
    try {
      const various = await artistStub({ name: 'Various Artists', mbid: '89ad4ac3-39f7-470e-963a-56509c546377' })
      // What older code stored: a store's stock photo and Wikipedia's article on compilation albums.
      const photo = await remoteImage('https://cdn-images.dzcdn.net/images/artist/various/1000x1000.jpg', { kind: 'artist' })
      await db.update(artists).set({ imageAssetId: photo.id, bio: 'A compilation album comprises tracks…', bioSource: 'wikipedia', bioUrl: 'https://en.wikipedia.org/wiki/Compilation_album' })
        .where(eq(artists.id, various))
      const before = await counts()
      http.requests.length = 0
      await hydrateArtist(various)
      expect(await artistRow(various)).toMatchObject({
        name: 'Various Artists', detailLevel: 2, imageAssetId: null, bio: null, bioSource: null, bioUrl: null,
        // MusicBrainz's are "add compilations to this artist" and the genres of what is filed under it.
        disambiguation: null, genres: [],
      })
      expect(http.requests.filter((url) => url.includes('release-group'))).toEqual([])
      // No picture is looked for.
      expect(http.requests.filter((url) => !url.includes('musicbrainz.org'))).toEqual([])
      expect(await counts()).toEqual(before)
    } finally {
      await updateServerSettings({ deezerEnabled: true, wikidataEnabled: true })
    }
  })
})

describe('artist detail, first answer and pictures', () => {
  useTestDatabase()
  useHttpFixtures('enrichment', 'musicbrainz', 'deezer', 'wikidata', 'fanart', 'listenbrainz')
  let userId = ''

  beforeAll(async () => {
    userId = (await createUser()).id
  })
  beforeEach(() => setDetailBudget(60_000))
  afterAll(() => setDetailBudget(4000))

  it('answers with Deezer’s dated discography before MusicBrainz’s is in', async () => {
    const existing = await artistStub({ name: 'Radiohead', mbid: radiohead })
    const stub = await artistStub({ name: 'Radiohead', deezerId: 399 })
    // MusicBrainz is busy: nothing it answers arrives until the first answer has been read.
    const fixtures = globalThis.fetch
    let open: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      open = resolve
    })
    vi.stubGlobal('fetch', async (...args: Parameters<typeof fetch>) => {
      if (String(args[0] instanceof Request ? args[0].url : args[0]).includes('musicbrainz.org')) await gate
      return fixtures(...args)
    })
    try {
      // Usable before the run is done: the page does not wait for MusicBrainz.
      expect(await ensureArtistDetail(stub)).toBe(false)
      const first = await artistDetail(userId, stub)
      expect(first.detailPending).toBe(true)
      const listed = first.sections!.flatMap((section) => section.items)
      expect(listed.length).toBeGreaterThan(10)
      expect(listed.filter((album) => album.year).length).toBeGreaterThan(listed.length * 0.9)
    } finally {
      open()
      vi.stubGlobal('fetch', fixtures)
    }

    await artistDetailRun(stub)
    const page = await artistDetail(userId, stub)
    expect(page.id).toBe(existing)
    expect(page.detailPending).toBeUndefined()
  })

  it('chooses the picture again from the artist’s own Deezer page, but keeps one from the user’s folders', async () => {
    const [artist] = await db.execute<{ id: string }>(sql`select id from artists where mbid = ${radiohead}`)
    const namesake = await remoteImage('https://cdn-images.dzcdn.net/images/cover/namesake/1000x1000.jpg', { kind: 'artist' })
    await db.execute(sql`update artists set image_asset_id = ${namesake.id}, image_picked_at = null where id = ${artist!.id}`)
    await hydrateArtist(artist!.id, { force: true })
    const picked = await artistRow(artist!.id)
    expect(picked.imageAssetId).not.toBe(namesake.id)
    expect(picked.imagePickedAt).not.toBeNull()

    const [folder] = await db.insert(assets).values({ id: newPublicId(), kind: 'artist', source: 'folder:/music/Radiohead/artist.jpg', status: 'missing' }).returning()
    await db.execute(sql`update artists set image_asset_id = ${folder!.id} where id = ${artist!.id}`)
    await hydrateArtist(artist!.id, { force: true })
    expect((await artistRow(artist!.id)).imageAssetId).toBe(folder!.id)
  })

  it('gives artists fetched before this a ranked list and a picture chosen from their profile (the release repair)', async () => {
    const [artist] = await db.execute<{ id: string }>(sql`select id from artists where mbid = ${radiohead}`)
    await db.delete(artistTopTracks).where(eq(artistTopTracks.artistId, artist!.id))
    // The picture from the user's folders (the test before) would stay; one from a page search linked is chosen again.
    const linked = await remoteImage('https://cdn-images.dzcdn.net/images/cover/linked-by-search/1000x1000.jpg', { kind: 'artist' })
    await db.execute(sql`update artists set image_asset_id = ${linked.id}, image_picked_at = null where id = ${artist!.id}`)
    const result = await repairReleases()
    expect(result).toMatchObject({ rankedArtists: 1, imageArtists: 1 })
    const listed = await db.select({ source: artistTopTracks.source }).from(artistTopTracks).where(eq(artistTopTracks.artistId, artist!.id))
    expect(listed.length).toBeGreaterThan(10)
    expect(await artistRow(artist!.id)).toMatchObject({ imagePickedAt: expect.any(Date), imageAssetId: expect.not.stringMatching(linked.id) })
    // Done: the next run has nothing to do for it.
    expect(await repairReleases()).toMatchObject({ rankedArtists: 0, imageArtists: 0 })
  })

  it('moves a namesake’s Deezer page and the albums made from it to an artist of its own', async () => {
    const id = await artistStub({ name: 'Relaxing Rain Sounds Hub', mbid: '11111111-2222-4333-8444-000000000009', deezerId: 156692872 })
    const created = await deezerDiscography(id, '156692872')
    expect(created.length).toBeGreaterThan(0)
    await detachDeezerArtist(id, '156692872', created)
    const [moved] = await db.execute<{ artistId: string; albums: number }>(sql`
      select e.entity_id as "artistId", (select count(*) from albums a where a.primary_artist_id = e.entity_id)::int as albums
      from external_ids e where e.provider = 'deezer' and e.entity_type = 'artist' and e.external_id = '156692872'`)
    expect(moved!.artistId).not.toBe(id)
    expect(moved!.albums).toBe(created.length)
    expect(await db.select({ id: albums.id }).from(albums).where(eq(albums.primaryArtistId, id))).toEqual([])
    expect((await artistRow(moved!.artistId)).imageAssetId).not.toBeNull()
  })
})

describe('displayName', () => {
  const profile = (name: string, aliases: string[] = []) => ({ name, aliases: aliases.map((alias) => ({ name: alias, sortName: alias, locale: null, primary: false, type: null })) })

  it('keeps the name a user knows when MusicBrainz lists it, and takes MusicBrainz’s spelling of the same name', () => {
    expect(displayName('Kanye West', profile('Ye', ['Kanye West', 'Kanye Omari West']))).toBe('Kanye West')
    expect(displayName('Hikaru Utada', profile('宇多田ヒカル', ['Hikaru Utada', 'Utada']))).toBe('Hikaru Utada')
    expect(displayName('JAŸ-Z', profile('JAY‐Z', ['Jay Z', 'Shawn Carter']))).toBe('JAY‐Z')
    expect(displayName('Radiohead', profile('Radiohead'))).toBe('Radiohead')
    // A name MusicBrainz does not know for the artist gives way.
    expect(displayName('Nirvana (UK)', profile('Nirvana'))).toBe('Nirvana')
  })
})
