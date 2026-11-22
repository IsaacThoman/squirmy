import { mergeSearch } from '@squirmy/client-core'
import { SearchResults } from '@squirmy/contracts'
import { and, eq, sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from '../../app.js'
import { db } from '../../database/client.js'
import { albumArtists, albums, artists, assets, externalIds, recordingArtists, recordings, releases } from '../../database/schema.js'
import { updateServerSettings } from '../../lib/settings.js'
import { body, errorCode, signIn } from '../../test/api.js'
import { useTestDatabase } from '../../test/database.js'
import { createAlbum, createArtist } from '../../test/factories.js'
import { useHttpFixtures } from '../../test/http.js'
import { albumSummaries } from '../catalog/summaries.js'
import { materialize } from './materialize.js'
import { searchCatalog, type ProviderAlbum, type ProviderResults } from './providers.js'

const radioheadMbid = 'a74b1b7f-71a5-4011-9441-d0b5e4122711'
const okComputerGroup = 'b1392450-e666-3926-a536-22c65f834433'

async function counts() {
  type Counts = Record<'artists' | 'albums' | 'recordings' | 'externalIds' | 'albumArtists' | 'recordingArtists', number>
  const [row] = await db.execute<Counts>(sql`
    select (select count(*) from artists)::int as artists, (select count(*) from albums)::int as albums,
      (select count(*) from recordings)::int as recordings, (select count(*) from external_ids)::int as "externalIds",
      (select count(*) from album_artists)::int as "albumArtists", (select count(*) from recording_artists)::int as "recordingArtists"`)
  return row!
}

async function externalIdOf(type: 'artist' | 'album' | 'recording', entityId: string) {
  return db.select({ provider: externalIds.provider, externalId: externalIds.externalId }).from(externalIds)
    .where(and(eq(externalIds.entityType, type), eq(externalIds.entityId, entityId)))
}

/** A Deezer-shaped album for results built by hand. */
function album(id: string, title: string, artist: { id: string; name: string }, extra: Partial<ProviderAlbum> = {}): ProviderAlbum {
  return {
    id, mbid: null, title, artistCredit: artist.name, artists: [{ id: artist.id, mbid: null, name: artist.name, joinPhrase: '' }],
    type: 'album', year: null, releaseDate: null, artworkUrl: null, ...extra,
  }
}

describe('GET /search/catalog', () => {
  useTestDatabase()
  const http = useHttpFixtures('deezer', 'musicbrainz')
  let app: FastifyInstance
  let user: Awaited<ReturnType<typeof signIn>>
  let owned: Awaited<ReturnType<typeof createAlbum>>

  const search = async (q: string, limit: number) =>
    body(await app.inject({ url: `/api/v1/search/catalog?q=${encodeURIComponent(q)}&limit=${limit}`, headers: user.headers }), SearchResults)
  /** Every row a provider's answer was stored as, including those the route leaves out because the library shows them. */
  const stored = async (q: string, limit: number) => {
    const { provider, results } = await searchCatalog(q, limit)
    return materialize(provider!.idSource, results)
  }

  beforeAll(async () => {
    app = await buildApp()
    user = await signIn()
    // The user's copy of OK Computer, tagged without any ids.
    owned = await createAlbum({
      title: 'OK Computer', artist: await createArtist({ name: 'Radiohead' }), year: 1997, owned: true,
      tracks: [{ title: 'Airbag', durationMs: 284_000 }, { title: 'Lucky', durationMs: 259_000 }],
    })
  })
  afterEach(() => updateServerSettings({ deezerEnabled: true, musicBrainzEnabled: true }))
  afterAll(async () => {
    await app.close()
  })

  it('stores Deezer results as stubs, matched to owned music', async () => {
    const ids = await stored('Radiohead OK Computer', 5)
    expect(ids.artists).toEqual([])
    expect(ids.albums).toHaveLength(5)
    expect(ids.albums[0]).toBe(owned.albumId)
    expect(ids.tracks).toHaveLength(5)
    expect(ids.tracks.slice(0, 2)).toEqual([owned.tracks[1]!.recordingId, owned.tracks[0]!.recordingId])

    // The owned rows gained their Deezer ids and a cover, and nothing else changed.
    expect(await externalIdOf('album', owned.albumId)).toEqual([{ provider: 'deezer', externalId: '14879699' }])
    expect(await externalIdOf('artist', owned.artist.id)).toEqual([{ provider: 'deezer', externalId: '399' }])
    expect(await externalIdOf('recording', owned.tracks[1]!.recordingId)).toEqual([{ provider: 'deezer', externalId: '138539991' }])
    const [ownedAlbum] = await db.select().from(albums).where(eq(albums.id, owned.albumId))
    expect(ownedAlbum).toMatchObject({ title: 'OK Computer', detailLevel: 2, year: 1997 })
    const [cover] = await db.select().from(assets).where(eq(assets.id, ownedAlbum!.artworkAssetId!))
    expect(cover).toMatchObject({ status: 'remote', kind: 'cover', remoteUrl: expect.stringMatching(/^https:\/\/cdn-images\.dzcdn\.net\/images\/cover\/.+1000x1000/) })
  })

  it('leaves out what the library answer for the same query already shows', async () => {
    const results = await search('Radiohead OK Computer', 5)
    expect(results.provider).toBe('deezer')
    expect(results.albums.map((one) => [one.title, one.availability])).toEqual([
      ['OK Computer OKNOTOK 1997 2017', 'none'],
      ["MF Computer (Radiohead's OK Computer Reimagined)", 'none'],
      ['Strung Out On OK Computer: VSQ Performs Radiohead', 'none'],
      ['MCP Performs Radiohead: OK Computer (Instrumental Version)', 'none'],
    ])
    // Only what the library answer lists goes: it has the album but not these two songs,
    // so they stay, as owned. Tracks of the album the user does not have point at it too.
    const library = body(await app.inject({ url: '/api/v1/search/library?q=Radiohead+OK+Computer&limit=5', headers: user.headers }), SearchResults)
    expect(library.albums.map((one) => one.id)).toEqual([owned.albumId])
    expect(library.tracks).toEqual([])
    expect(results.tracks.map((one) => [one.title, one.availability, one.album?.id])).toEqual([
      ['Lucky', 'server', owned.albumId],
      ['Airbag', 'server', owned.albumId],
      ['Electioneering', 'none', owned.albumId],
      ['The Tourist', 'none', owned.albumId],
      ['Fitter Happier', 'none', owned.albumId],
    ])
    expect(results.top).toEqual({ type: 'album', id: results.albums[0]!.id, score: 1 })
    // Both hints are scored alike, so the merged list leads with the user's exact match
    // rather than the catalog's prefix one.
    expect(library.top).toEqual({ type: 'album', id: owned.albumId, score: 3 })
    expect(mergeSearch(library, results, { role: 'member', canAcquire: false }).top).toMatchObject({ type: 'album', album: { id: owned.albumId } })
  })

  it('writes stubs with the whole contract', async () => {
    const results = await search('Radiohead OK Computer', 5)
    const [stub] = await db.select().from(albums).where(eq(albums.id, results.albums[0]!.id))
    expect(stub).toMatchObject({
      title: 'OK Computer OKNOTOK 1997 2017', artistCredit: 'Radiohead', primaryArtistId: owned.artist.id, type: 'album',
      year: null, releaseDate: null, titleKey: 'ok computer oknotok 1997 2017', matchKey: 'radiohead|ok computer oknotok 1997 2017',
      detailLevel: 0, mbid: null, canonicalReleaseId: null,
    })
    expect(await db.select().from(releases).where(eq(releases.albumId, stub!.id))).toEqual([])
    expect(await db.select({ artistId: albumArtists.artistId, creditedName: albumArtists.creditedName }).from(albumArtists).where(eq(albumArtists.albumId, stub!.id)))
      .toEqual([{ artistId: owned.artist.id, creditedName: 'Radiohead' }])
    expect(await externalIdOf('album', stub!.id)).toEqual([{ provider: 'deezer', externalId: '43197211' }])
    const [cover] = await db.select().from(assets).where(eq(assets.id, stub!.artworkAssetId!))
    expect(cover).toMatchObject({ status: 'remote', storagePath: null })

    const falcon = results.albums[1]!
    expect(falcon.artists).toHaveLength(1)
    const [artist] = await db.select().from(artists).where(eq(artists.id, falcon.artists[0]!.id))
    expect(artist).toMatchObject({ name: 'Mother Falcon', nameKey: 'mother falcon', detailLevel: 0, mbid: null, imageAssetId: null })
    expect(await externalIdOf('artist', artist!.id)).toEqual([{ provider: 'deezer', externalId: '498395' }])

    const [track] = await db.select().from(recordings).where(eq(recordings.id, results.tracks[2]!.id))
    expect(track).toMatchObject({
      title: 'Electioneering', artistCredit: 'Radiohead', primaryArtistId: owned.artist.id, durationMs: 230_000,
      titleKey: 'electioneering', matchKey: 'radiohead|electioneering', explicit: false, isrcs: ['GBAYE9701371'],
      albumHintId: owned.albumId, mbid: null,
    })
    expect(track!.popularity).toBeCloseTo(0.576369)
    expect(await db.select({ artistId: recordingArtists.artistId }).from(recordingArtists).where(eq(recordingArtists.recordingId, track!.id)))
      .toEqual([{ artistId: owned.artist.id }])
    expect(await externalIdOf('recording', track!.id)).toEqual([{ provider: 'deezer', externalId: '138539985' }])
  })

  it('is idempotent', async () => {
    const before = await counts()
    const first = await search('Radiohead OK Computer', 5)
    const again = await search('radiohead  ok computer', 5)
    expect(again).toEqual(first)
    expect(await counts()).toEqual(before)
  })

  it('shares one provider call between identical searches and creates each stub once', async () => {
    const before = await counts()
    const responses = await Promise.all(Array.from({ length: 4 }, () => search('radiohead', 3)))
    expect(http.requests.filter((request) => request.includes('api.deezer.com/search'))).toHaveLength(3)
    for (const response of responses) expect(response).toEqual(responses[0])
    // Found by name and given the Deezer image; the library answer has it, so the catalog answer does not.
    expect((await stored('radiohead', 3)).artists[0]).toBe(owned.artist.id)
    expect(responses[0]!.artists.map((artist) => artist.id)).not.toContain(owned.artist.id)
    const [radiohead] = await db.select().from(artists).where(eq(artists.id, owned.artist.id))
    expect(radiohead!.imageAssetId).not.toBeNull()
    const duplicates = await db.execute(sql`select match_key from albums group by match_key, type having count(*) > 1
      union all select match_key from recordings group by match_key, duration_ms having count(*) > 1`)
    expect(duplicates).toEqual([])
    expect((await counts()).albums).toBeGreaterThan(before.albums)
  })

  it('stays consistent when the same results are stored concurrently', async () => {
    const band = { id: 'concurrent-artist', name: 'Concurrent Band' }
    const results: ProviderResults = {
      artists: [{ id: band.id, mbid: null, name: band.name, imageUrl: 'https://images.example.test/band.jpg' }],
      albums: [album('concurrent-album', 'Parallel Lines', band, { artworkUrl: 'https://images.example.test/lines.jpg' })],
      tracks: [{
        id: 'concurrent-track', mbid: null, title: 'Race Condition', artistCredit: band.name, artists: album('', '', band).artists,
        durationMs: 200_000, explicit: true, popularity: 0.5, isrcs: [], album: album('concurrent-album', 'Parallel Lines', band),
      }],
    }
    const before = await counts()
    const all = await Promise.all(Array.from({ length: 6 }, () => materialize('deezer', results)))
    for (const ids of all) expect(ids).toEqual(all[0])
    expect(await counts()).toEqual({
      ...before,
      artists: before.artists + 1, albums: before.albums + 1, recordings: before.recordings + 1, externalIds: before.externalIds + 3,
      albumArtists: before.albumArtists + 1, recordingArtists: before.recordingArtists + 1,
    })
  })

  it("finds the user's album under other punctuation, and keeps other editions apart", async () => {
    const beatles = await createArtist({ name: 'The Beatles' })
    const abbey = await createAlbum({ title: 'Abbey Road', artist: beatles, owned: true, tracks: [{ title: 'Come Together' }] })
    const nirvana = await createArtist({ name: 'Nirvana' })
    const nevermind = await createAlbum({ title: 'Nevermind (Remastered)', artist: nirvana, owned: true, tracks: [{ title: 'Lithium' }] })
    const dz = (name: string) => ({ id: `dz-${name}`, name })
    const ids = await materialize('deezer', {
      artists: [],
      albums: [
        album('1', 'Abbey Road (Remastered 2019)', dz('The Beatles')),
        album('2', 'ABBEY ROAD!', dz('The Beatles')),
        album('3', 'Abbey Road - 50th Anniversary Super Deluxe Edition', dz('The Beatles')),
        album('4', 'Nevermind', dz('Nirvana')),
        album('5', 'Nevermind [Deluxe Edition] (Explicit)', dz('Nirvana')),
        album('6', 'Abbey Road Sessions', dz('The Beatles')),
        album('7', 'Nevermind (Live at the Paramount)', dz('Nirvana')),
        album('8', 'Abbey Road', dz('The Abbey Road Tribute Band')),
        album('9', 'Abbey Road', dz('The Beatles'), { type: 'single' }),
      ],
      tracks: [],
    })
    // Other punctuation and store labels are the same edition; edition words name another
    // edition, with its own songs, so it is not the user's copy.
    expect(ids.albums[1]).toBe(abbey.albumId)
    expect(ids.albums).not.toContain(nevermind.albumId)
    expect(ids.albums).toHaveLength(8)
    const created = await db.select({ title: albums.title, type: albums.type }).from(albums)
      .where(sql`${albums.id} = any(${`{${ids.albums.filter((id) => id !== abbey.albumId).join(',')}}`}::uuid[])`)
    expect(created.map((row) => row.title).sort()).toEqual([
      'Abbey Road', 'Abbey Road (Remastered 2019)', 'Abbey Road - 50th Anniversary Super Deluxe Edition', 'Abbey Road Sessions',
      'Nevermind', 'Nevermind (Live at the Paramount)', 'Nevermind [Deluxe Edition] (Explicit)',
    ])
  })

  it('shows music added after it was searched as owned', async () => {
    const band = { id: 'late-artist', name: 'Late Band' }
    const results: ProviderResults = {
      artists: [],
      albums: [album('late-album', 'Arrived Later', band)],
      tracks: [{
        id: 'late-track', mbid: null, title: 'First Song', artistCredit: band.name, artists: album('', '', band).artists,
        durationMs: 180_000, explicit: false, popularity: null, isrcs: [], album: album('late-album', 'Arrived Later', band),
      }],
    }
    const stubs = await materialize('deezer', results)
    const copy = await createAlbum({ title: 'Arrived Later', artist: await createArtist({ name: 'Late Band' }), owned: true, tracks: [{ title: 'First Song', durationMs: 181_000 }] })
    const ids = await materialize('deezer', results)
    expect(ids).toEqual({ artists: [], albums: [copy.albumId], tracks: [copy.tracks[0]!.recordingId] })
    expect(await externalIdOf('album', copy.albumId)).toEqual([{ provider: 'deezer', externalId: 'late-album' }])
    expect(await externalIdOf('album', stubs.albums[0]!)).toEqual([])
    expect(await externalIdOf('recording', copy.tracks[0]!.recordingId)).toEqual([{ provider: 'deezer', externalId: 'late-track' }])
    expect(await materialize('deezer', results)).toEqual(ids)
  })

  it('looks rows up by external id before anything else', async () => {
    const artist = await createArtist({ name: 'Known Artist' })
    const known = await createAlbum({ title: 'Renamed Locally', artist })
    await db.insert(externalIds).values({ provider: 'deezer', entityType: 'album', externalId: 'known-album', entityId: known.albumId })
    const ids = await materialize('deezer', { artists: [], albums: [album('known-album', 'Original Title', { id: 'known', name: 'Known Artist' })], tracks: [] })
    expect(ids.albums).toEqual([known.albumId])
    const [row] = await db.select().from(albums).where(eq(albums.id, known.albumId))
    expect(row!.title).toBe('Renamed Locally')
  })

  it('does not take an artist of the same name when the name is ambiguous or already another id', async () => {
    const first = await createArtist({ name: 'Twin Name' })
    await createArtist({ name: 'Twin Name' })
    const solo = await createArtist({ name: 'Solo Name' })
    await db.insert(externalIds).values({ provider: 'deezer', entityType: 'artist', externalId: 'solo-1', entityId: solo.id })
    const ids = await materialize('deezer', {
      artists: [{ id: 'twin-9', mbid: null, name: 'Twin Name', imageUrl: null }, { id: 'solo-2', mbid: null, name: 'Solo Name', imageUrl: null }],
      albums: [],
      tracks: [],
    })
    expect(ids.artists).not.toContain(first.id)
    expect(ids.artists).not.toContain(solo.id)
    expect(ids.artists).toHaveLength(2)
  })

  it('uses MusicBrainz when Deezer is off, and reuses rows by MBID', async () => {
    await updateServerSettings({ deezerEnabled: false })
    await db.update(albums).set({ mbid: okComputerGroup }).where(eq(albums.id, owned.albumId))
    const ids = await stored('ok computer', 3)
    expect(http.requests.every((request) => request.includes('musicbrainz.org'))).toBe(true)
    expect(ids.albums).toContain(owned.albumId)
    // The owned artist had no MBID; it is the only Radiohead, so the name finds it.
    const [ownedSummary] = await albumSummaries([owned.albumId])
    expect(ownedSummary!.artists[0]!.id).toBe(owned.artist.id)
    expect(await externalIdOf('artist', owned.artist.id)).toContainEqual({ provider: 'musicbrainz', externalId: radioheadMbid })

    const results = await search('ok computer', 3)
    expect(results.provider).toBe('musicbrainz')
    // The owned album is the library answer's; the catalog answer has the rest.
    expect(results.albums.map((one) => one.id)).toEqual(ids.albums.filter((id) => id !== owned.albumId))
    const stub = results.albums[0]!
    const [row] = await db.select().from(albums).where(eq(albums.id, stub.id))
    expect(row).toMatchObject({ mbid: stub.mbid, detailLevel: 0 })
    expect(await externalIdOf('album', stub.id)).toEqual([{ provider: 'musicbrainz', externalId: stub.mbid }])
    const [cover] = await db.select().from(assets).where(eq(assets.id, row!.artworkAssetId!))
    expect(cover!.remoteUrl).toBe(`https://coverartarchive.org/release-group/${stub.mbid}/front-500`)
    for (const track of results.tracks) {
      const [recording] = await db.select().from(recordings).where(eq(recordings.id, track.id))
      expect(recording!.mbid).toBe(track.mbid)
    }

    // Searched again, every row is found by its MBID or MusicBrainz id.
    const before = await counts()
    expect(await search('ok computer', 3)).toEqual(results)
    expect(await counts()).toEqual(before)
  })

  it('falls through to MusicBrainz when Deezer fails', async () => {
    const results = await search('karma police', 3)
    expect(results.provider).toBe('musicbrainz')
    expect(http.requests.some((request) => request.includes('api.deezer.com/search'))).toBe(true)
    expect(results.tracks.length).toBeGreaterThan(0)
  })

  it('answers 502 when every provider fails', async () => {
    await updateServerSettings({ musicBrainzEnabled: false })
    expect(errorCode(await app.inject({ url: '/api/v1/search/catalog?q=karma+police&limit=3', headers: user.headers }), 502)).toBe('provider_unavailable')
  })

  it('answers nothing for queries under two characters or with every provider off', async () => {
    expect(await search('a', 3)).toEqual({ artists: [], albums: [], tracks: [], provider: null, top: null })
    await updateServerSettings({ deezerEnabled: false, musicBrainzEnabled: false })
    expect(await search('radiohead', 3)).toEqual({ artists: [], albums: [], tracks: [], provider: null, top: null })
    expect(http.requests).toEqual([])
  })

  it('needs a session', async () => {
    expect(errorCode(await app.inject({ url: '/api/v1/search/catalog?q=radiohead' }), 401)).toBe('unauthorized')
  })
})
