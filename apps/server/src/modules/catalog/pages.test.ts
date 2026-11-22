import { AlbumDetail, AlbumPage, ARTIST_SECTION_PREVIEW, ArtistDetail, HomeResponse, Lyrics, TrackPage, TrackSummariesResponse, TrackSummary } from '@squirmy/contracts'
import { and, eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildApp } from '../../app.js'
import { db } from '../../database/client.js'
import { albumArtists, albums, artistTopTracks, artists, likes, lyrics, mediaFiles, playlistItems, playlists, recordingArtists, recordings, releaseTracks, wants } from '../../database/schema.js'
import { newId } from '../../lib/ids.js'
import { updateServerSettings } from '../../lib/settings.js'
import { body, errorCode, signIn } from '../../test/api.js'
import { createAsset, createPlay } from '../../test/catalog.js'
import { useTestDatabase } from '../../test/database.js'
import { createAlbum, createArtist } from '../../test/factories.js'
import { ensureAlbumDetail, ensureArtistDetail } from '../enrichment/detail.js'
import { standingRows } from './pages.js'

vi.mock('../enrichment/detail.js', () => ({
  ensureAlbumDetail: vi.fn(async () => {}),
  ensureArtistDetail: vi.fn(async () => {}),
  ensureLyrics: vi.fn(async () => {}),
}))

describe('catalog pages', () => {
  useTestDatabase()
  let app: FastifyInstance
  let user: Awaited<ReturnType<typeof signIn>>
  const get = (url: string) => app.inject({ url: `/api/v1${url}`, headers: user.headers })

  beforeAll(async () => {
    app = await buildApp()
    user = await signIn()
  })
  beforeEach(() => vi.mocked(ensureAlbumDetail).mockClear())
  afterAll(async () => {
    await app.close()
  })

  it('shows an album by disc with per-track availability', async () => {
    const album = await createAlbum({
      title: 'Two Sides',
      owned: [0, 2],
      tracks: [{ title: 'One' }, { title: 'Two' }, { title: 'Three', disc: 2 }],
    })
    await db.update(releaseTracks).set({ discTitle: 'Bonus' }).where(eq(releaseTracks.id, album.tracks[2]!.releaseTrackId))
    await db.update(albums).set({ genres: ['Ambient'], description: 'Quiet.' }).where(eq(albums.id, album.albumId))
    await db.insert(likes).values({ userId: user.id, entityType: 'album', entityId: album.albumId })
    await db.insert(wants).values({ userId: user.id, entityType: 'album', entityId: album.albumId })
    // Nothing is wanted while the wantlist is off.
    expect(body(await get(`/albums/${album.albumId}`), AlbumDetail).wanted).toBe(false)

    await updateServerSettings({ wantlistEnabled: true })
    const detail = body(await get(`/albums/${album.albumId}`), AlbumDetail)
    await updateServerSettings({ wantlistEnabled: false })
    expect(ensureAlbumDetail).toHaveBeenCalledWith(album.albumId)
    expect(detail).toMatchObject({
      title: 'Two Sides', availability: 'partial', trackCount: 3, ownedTrackCount: 2, liked: true, wanted: true,
      genres: ['Ambient'], description: 'Quiet.', releaseDate: '2024', label: null,
      durationMs: album.tracks.reduce((sum, track) => sum + track.durationMs, 0),
    })
    expect(detail.discs.map((disc) => [disc.disc, disc.title, disc.tracks.map((track) => [track.title, track.position, track.availability])])).toEqual([
      [1, null, [['One', 1, 'server'], ['Two', 2, 'none']]],
      [2, 'Bonus', [['Three', 1, 'server']]],
    ])
    expect(detail.discs[0]!.tracks.every((track) => track.album?.id === album.albumId)).toBe(true)
  })

  it('lists owned tracks the release does not have after its own, unnumbered and in the album', async () => {
    const album = await createAlbum({ title: 'Standard Edition', owned: true, tracks: [{ title: 'Opener' }, { title: 'Closer' }] })
    // Bonus tracks the matcher attached to the album with no release track.
    const bonus = await createAlbum({ owned: true, tracks: [{ title: 'Bonus B' }, { title: 'Bonus A' }] })
    for (const [index, track] of bonus.tracks.entries()) {
      await db.update(mediaFiles).set({ albumId: album.albumId, releaseId: album.releaseId, releaseTrackId: null, relPath: `Standard/0${3 + index} ${track.title}.flac` })
        .where(eq(mediaFiles.id, track.fileId!))
    }
    const detail = body(await get(`/albums/${album.albumId}`), AlbumDetail)
    expect(detail.discs.map((disc) => [disc.disc, disc.tracks.map((track) => [track.title, track.position, track.availability, track.album?.id])])).toEqual([
      [1, [['Opener', 1, 'server', album.albumId], ['Closer', 2, 'server', album.albumId], ['Bonus B', null, 'server', album.albumId], ['Bonus A', null, 'server', album.albumId]]],
    ])
    expect(detail).toMatchObject({ availability: 'full', trackCount: 4, ownedTrackCount: 4 })

    const library = body(await get('/library/tracks?limit=50'), TrackPage)
    expect(library.items.map((track) => track.id)).toEqual(expect.arrayContaining(bonus.tracks.map((track) => track.recordingId)))
  })

  it('answers 404 with stable codes and 400 for malformed ids', async () => {
    expect(errorCode(await get(`/albums/${newId()}`), 404)).toBe('album_not_found')
    expect(errorCode(await get(`/artists/${newId()}`), 404)).toBe('artist_not_found')
    expect(errorCode(await get(`/tracks/${newId()}`), 404)).toBe('track_not_found')
    expect(errorCode(await get(`/tracks/${newId()}/lyrics`), 404)).toBe('track_not_found')
    expect(errorCode(await get('/albums/not-an-id'), 400)).toBe('invalid_request')
    expect(errorCode(await app.inject({ url: `/api/v1/albums/${newId()}` }), 401)).toBe('unauthorized')
  })

  it('follows merge redirects on every page', async () => {
    const winner = await createAlbum({ owned: true })
    const loser = await createAlbum()
    const loserArtist = await createArtist()
    await db.update(albums).set({ mergedIntoId: winner.albumId }).where(eq(albums.id, loser.albumId))
    await db.update(artists).set({ mergedIntoId: winner.artist.id }).where(eq(artists.id, loserArtist.id))
    await db.update(recordings).set({ mergedIntoId: winner.tracks[0]!.recordingId }).where(eq(recordings.id, loser.tracks[0]!.recordingId))

    expect(body(await get(`/albums/${loser.albumId}`), AlbumDetail).id).toBe(winner.albumId)
    expect(ensureAlbumDetail).toHaveBeenCalledWith(winner.albumId)
    expect(body(await get(`/artists/${loserArtist.id}`), ArtistDetail).id).toBe(winner.artist.id)
    expect(body(await get(`/tracks/${loser.tracks[0]!.recordingId}`), TrackSummary).id).toBe(winner.tracks[0]!.recordingId)
  })

  it('shows an artist with its discography newest first and top tracks by plays', async () => {
    const artist = await createArtist({ name: 'Orla' })
    const image = await createAsset('#abcdef')
    await db.update(artists).set({ imageAssetId: image.id, bio: 'Sings.', genres: ['Folk'] }).where(eq(artists.id, artist.id))
    const older = await createAlbum({ artist, title: 'Older', year: 2001, owned: true })
    const newer = await createAlbum({ artist, title: 'Newer', year: 2020 })
    // Credited on someone else's album too.
    const guest = await createAlbum({ title: 'Split', year: 2010 })
    await db.insert(albumArtists).values({ albumId: guest.albumId, position: 1, artistId: artist.id, creditedName: 'Orla' })

    const [first, second, third] = older.tracks
    await db.update(recordings).set({ popularity: 0.9 }).where(eq(recordings.id, third!.recordingId))
    await db.update(recordings).set({ popularity: 0.5 }).where(eq(recordings.id, newer.tracks[0]!.recordingId))
    for (let index = 0; index < 3; index++) await createPlay({ userId: user.id, recordingId: second!.recordingId })
    await createPlay({ userId: user.id, recordingId: first!.recordingId })
    // Skips do not count.
    for (let index = 0; index < 5; index++) await createPlay({ userId: user.id, recordingId: newer.tracks[1]!.recordingId, completed: false })

    const detail = body(await get(`/artists/${artist.id}`), ArtistDetail)
    expect(ensureArtistDetail).toHaveBeenCalledWith(artist.id)
    expect(detail).toMatchObject({ name: 'Orla', inLibrary: true, bio: 'Sings.', genres: ['Folk'], liked: false, similar: [] })
    expect(detail.image?.color).toBe('#abcdef')
    expect(detail.albums.map((album) => album.title)).toEqual(['Newer', 'Older'])
    expect(detail.albums.map((album) => album.availability)).toEqual(['none', 'full'])
    // Led by another artist: "Appears on".
    expect(detail.appearsOn?.map((album) => album.title)).toEqual(['Split'])
    expect(detail.topTracks.slice(0, 4).map((track) => track.id)).toEqual([
      second!.recordingId, first!.recordingId, third!.recordingId, newer.tracks[0]!.recordingId,
    ])
  })

  it('lists the discography in sections, with the first releases of each and counts', async () => {
    const artist = await createArtist({ name: 'Weezy' })
    await createAlbum({ artist, title: 'Tha Carter', year: 2004, owned: true })
    const mixtape = await createAlbum({ artist, title: 'Dedication 2', year: 2006 })
    await db.update(albums).set({ secondaryTypes: ['Mixtape/Street'] }).where(eq(albums.id, mixtape.albumId))
    // One soundtrack beside two albums is one of the albums (Help!).
    await createAlbum({ artist, title: 'Rebirth', year: 2010 })
    await createAlbum({ artist, title: 'Help!', year: 1965, type: 'soundtrack' })
    for (let index = 0; index < ARTIST_SECTION_PREVIEW + 3; index++) await createAlbum({ artist, title: `Single ${index}`, year: 2000 + index, type: 'single' })
    // Featured on a track of someone else's album, with no credit on the album itself.
    const feature = await createAlbum({ title: 'Miami', year: 2023 })
    await db.insert(recordingArtists).values({ recordingId: feature.tracks[0]!.recordingId, position: 1, artistId: artist.id, creditedName: 'Weezy' })

    const detail = body(await get(`/artists/${artist.id}`), ArtistDetail)
    expect(detail.sections!.map((section) => [section.key, section.title, section.total, section.items.length])).toEqual([
      ['album', 'Albums', 3, 3], ['mixtape', 'Mixtapes', 1, 1], ['single', 'Singles', ARTIST_SECTION_PREVIEW + 3, ARTIST_SECTION_PREVIEW], ['appears_on', 'Appears on', 1, 1],
    ])
    expect(detail.sections![0]!.items.map((album) => album.title)).toEqual(['Rebirth', 'Tha Carter', 'Help!'])
    expect(detail.sections![2]!.items[0]!.title).toBe(`Single ${ARTIST_SECTION_PREVIEW + 2}`)
    expect(detail).toMatchObject({ releaseCount: ARTIST_SECTION_PREVIEW + 3 + 4, ownedReleaseCount: 1 })
    // Older clients get the same previews.
    expect(detail.albums).toHaveLength(3 + 1 + ARTIST_SECTION_PREVIEW)
    expect(detail.appearsOn!.map((album) => album.title)).toEqual(['Miami'])

    // "See all" pages the rest of a section, in the page's order, and stops.
    const first = body(await get(`/artists/${artist.id}/releases?section=single&limit=10`), AlbumPage)
    expect(first.items.map((album) => album.title)).toEqual(Array.from({ length: 10 }, (_, index) => `Single ${ARTIST_SECTION_PREVIEW + 2 - index}`))
    // A release added meanwhile does not repeat or skip one.
    await createAlbum({ artist, title: 'Single new', year: 2030, type: 'single' })
    const rest = body(await get(`/artists/${artist.id}/releases?section=single&limit=10&cursor=${first.nextCursor}`), AlbumPage)
    expect(rest.items.map((album) => album.title)).toEqual(Array.from({ length: 5 }, (_, index) => `Single ${4 - index}`))
    expect(rest.nextCursor).toBeNull()
    expect(errorCode(await get(`/artists/${artist.id}/releases?section=album&cursor=${first.nextCursor}`), 400)).toBe('invalid_cursor')
    expect(errorCode(await get(`/artists/${artist.id}/releases?section=nope`), 400)).toBe('invalid_request')
  })

  it('lists the stored top tracks in their order, each song once', async () => {
    const artist = await createArtist({ name: 'Creep Band' })
    const album = await createAlbum({ artist, title: 'Pablo Honey', tracks: [{ title: 'You' }, { title: 'Creep' }, { title: 'Creep' }, { title: 'Lurgee' }] })
    const [you, creep, creepAgain, lurgee] = album.tracks
    // Plays here and a popularity from search no longer outrank the artist's hits.
    for (let index = 0; index < 5; index++) await createPlay({ userId: user.id, recordingId: lurgee!.recordingId })
    await db.update(recordings).set({ popularity: 1 }).where(eq(recordings.id, you!.recordingId))
    await db.insert(artistTopTracks).values([creep, creepAgain, you].map((track, position) => ({ artistId: artist.id, position, recordingId: track!.recordingId, source: 'deezer' })))
    const detail = body(await get(`/artists/${artist.id}`), ArtistDetail)
    expect(detail.topTracks.map((track) => track.id)).toEqual([creep!.recordingId, you!.recordingId])
  })

  it('gives Various Artists no top tracks, radio or similar artists', async () => {
    const various = await createArtist({ name: 'Various Artists', mbid: '89ad4ac3-39f7-470e-963a-56509c546377' })
    const compilation = await createAlbum({ artist: various, title: 'Now 1', owned: true })
    await db.insert(artistTopTracks).values({ artistId: various.id, position: 0, recordingId: compilation.tracks[0]!.recordingId, source: 'listenbrainz' })
    const detail = body(await get(`/artists/${various.id}`), ArtistDetail)
    expect(detail).toMatchObject({ topTracks: [], radio: false, similar: [] })
    expect(detail.sections!.map((section) => section.key)).toEqual(['album'])
  })

  it('orders a discography by year when an album has no release date', async () => {
    const artist = await createArtist()
    await createAlbum({ artist, title: 'Dated', year: 2001 })
    const undated = await createAlbum({ artist, title: 'Undated', year: 2020 })
    const unknown = await createAlbum({ artist, title: 'Unknown' })
    await db.update(albums).set({ releaseDate: null }).where(eq(albums.id, undated.albumId))
    await db.update(albums).set({ releaseDate: null, year: null }).where(eq(albums.id, unknown.albumId))
    const detail = body(await get(`/artists/${artist.id}`), ArtistDetail)
    expect(detail.albums.map((album) => album.title)).toEqual(['Undated', 'Dated', 'Unknown'])
  })

  it('lists an album the artist leads without credit rows', async () => {
    const artist = await createArtist()
    const album = await createAlbum({ artist, title: 'Bare' })
    await db.delete(albumArtists).where(eq(albumArtists.albumId, album.albumId))
    const detail = body(await get(`/artists/${artist.id}`), ArtistDetail)
    expect(detail.albums.map((one) => [one.id, one.artists])).toEqual([[album.albumId, [{ id: artist.id, name: artist.name }]]])
  })

  it('returns a track in an album context, and its lyrics', async () => {
    const album = await createAlbum({ owned: true })
    const other = await createAlbum({ tracks: [{ title: 'Elsewhere' }] })
    const recordingId = album.tracks[1]!.recordingId
    expect(body(await get(`/tracks/${recordingId}`), TrackSummary)).toMatchObject({ album: { id: album.albumId }, position: 2 })
    expect(body(await get(`/tracks/${recordingId}?albumId=${other.albumId}`), TrackSummary)).toMatchObject({ album: { id: other.albumId }, position: null })

    expect(errorCode(await get(`/tracks/${recordingId}/lyrics`), 404)).toBe('lyrics_not_found')
    await db.insert(lyrics).values({ recordingId, source: 'none' })
    expect(errorCode(await get(`/tracks/${recordingId}/lyrics`), 404)).toBe('lyrics_not_found')
    await db.update(lyrics).set({ synced: '[00:01.00] hi', plain: 'hi', source: 'lrclib' }).where(eq(lyrics.recordingId, recordingId))
    expect(body(await get(`/tracks/${recordingId}/lyrics`), Lyrics)).toEqual({
      trackId: recordingId, synced: '[00:01.00] hi', plain: 'hi', instrumental: false, source: 'lrclib',
    })
  })

  it('hydrates track summaries in request order, dropping unknown ids', async () => {
    const album = await createAlbum({ owned: true })
    const [a, b] = album.tracks
    const response = await app.inject({
      method: 'POST', url: '/api/v1/tracks/summaries', headers: user.headers,
      payload: { tracks: [{ id: b!.recordingId }, { id: newId() }, { id: a!.recordingId, albumId: album.albumId }, { id: b!.recordingId, albumId: null }] },
    })
    const result = body(response, TrackSummariesResponse)
    expect(result.tracks.map((track) => track.id)).toEqual([b!.recordingId, a!.recordingId, b!.recordingId])
    expect(result.requestedIds).toEqual([b!.recordingId, a!.recordingId, b!.recordingId])

    // A merged id is answered with the row it was merged into, and says which id it stands for.
    const loser = await createAlbum({ tracks: [{ title: 'Merged Away' }] })
    const merged = loser.tracks[0]!.recordingId
    await db.update(recordings).set({ mergedIntoId: a!.recordingId }).where(eq(recordings.id, merged))
    const redirected = body(await app.inject({
      method: 'POST', url: '/api/v1/tracks/summaries', headers: user.headers, payload: { tracks: [{ id: newId() }, { id: merged }] },
    }), TrackSummariesResponse)
    expect(redirected.tracks.map((track) => track.id)).toEqual([a!.recordingId])
    expect(redirected.requestedIds).toEqual([merged])

    const tooMany = Array.from({ length: 501 }, () => ({ id: a!.recordingId }))
    const rejected = await app.inject({ method: 'POST', url: '/api/v1/tracks/summaries', headers: user.headers, payload: { tracks: tooMany } })
    expect(errorCode(rejected, 400)).toBe('invalid_request')
  })

  it('builds home from sections with content, with stable ids', async () => {
    const fresh = await signIn()
    const homeOf = async () => body(await app.inject({ url: '/api/v1/home', headers: fresh.headers }), HomeResponse).sections

    // Only the shared library has content for a new user.
    expect((await homeOf()).map((section) => section.id)).toEqual(['recently-added'])

    const played = await createAlbum({ owned: true, title: 'Played' })
    const liked = await createAlbum({ title: 'Liked' })
    const wanted = await createAlbum({ title: 'Wanted' })
    await createPlay({ userId: fresh.id, recordingId: played.tracks[0]!.recordingId, albumId: played.albumId, minutesAgo: 10 })
    await createPlay({ userId: fresh.id, recordingId: played.tracks[1]!.recordingId, albumId: played.albumId, minutesAgo: 5 })
    await createPlay({ userId: fresh.id, recordingId: played.tracks[1]!.recordingId, albumId: played.albumId, minutesAgo: 1 })
    await createPlay({ userId: fresh.id, recordingId: played.tracks[2]!.recordingId, minutesAgo: 60 * 24 * 100 })
    await db.insert(likes).values({ userId: fresh.id, entityType: 'album', entityId: liked.albumId })
    await db.insert(wants).values({ userId: fresh.id, entityType: 'album', entityId: wanted.albumId })
    // A want for something already owned is fulfilled and leaves the rail.
    await db.insert(wants).values({ userId: fresh.id, entityType: 'album', entityId: played.albumId })
    const playlistId = newId()
    await db.insert(playlists).values({ id: playlistId, ownerId: fresh.id, name: 'Mine' })
    await db.insert(playlistItems).values({ id: newId(), playlistId, position: 0, recordingId: played.tracks[0]!.recordingId, albumId: played.albumId })
    // Someone else's public playlist is not "yours".
    await db.insert(playlists).values({ id: newId(), ownerId: user.id, name: 'Theirs', isPublic: true })

    // The wantlist is off by default: Home leaves it out and does not refresh wants.
    expect((await homeOf()).map((section) => section.id)).toEqual(['recently-added', 'recently-played', 'most-played', 'playlists', 'liked-albums'])
    const ownedWant = async () => (await db.select({ fulfilledAt: wants.fulfilledAt }).from(wants)
      .where(and(eq(wants.userId, fresh.id), eq(wants.entityId, played.albumId))))[0]!.fulfilledAt
    expect(await ownedWant()).toBeNull()
    await updateServerSettings({ wantlistEnabled: true })

    const sections = await homeOf()
    expect(sections.map((section) => section.id)).toEqual(['recently-added', 'recently-played', 'most-played', 'playlists', 'liked-albums', 'wantlist'])
    const byId = Object.fromEntries(sections.map((section) => [section.id, section]))
    expect(byId['recently-added']).toMatchObject({ kind: 'albums', title: 'Recently added' })
    expect(byId['recently-added']!.kind === 'albums' && byId['recently-added']!.albums[0]!.id).toBe(played.albumId)
    expect(byId['recently-played']).toMatchObject({ kind: 'albums', albums: [{ id: played.albumId }] })
    // The play from 100 days ago is outside the window.
    expect(byId['most-played']).toMatchObject({ kind: 'tracks', tracks: [{ id: played.tracks[1]!.recordingId }, { id: played.tracks[0]!.recordingId }] })
    expect(byId.playlists).toMatchObject({ kind: 'playlists', title: 'Your playlists', playlists: [{ name: 'Mine', trackCount: 1 }] })
    expect(byId['liked-albums']).toMatchObject({ kind: 'albums', albums: [{ id: liked.albumId }] })
    expect(byId.wantlist).toMatchObject({ kind: 'albums', albums: [{ id: wanted.albumId }] })
    expect(await ownedWant()).not.toBeNull()
  })
})

describe('standingRows', () => {
  const row = (id: string, title: string, type: string, extra: Partial<Parameters<typeof standingRows>[0][number]> = {}) => ({
    id, title, type, typeGuessed: false, secondaryTypes: [] as string[], hasMbid: true, detailLevel: 1, year: 2025, hasArtwork: true, owned: false, led: true, ...extra,
  })

  it('lists each release once, in the given order', () => {
    const rows = [
      row('a', 'Sports car', 'single'),
      // A stub made from the song's album reference, not merged yet.
      row('b', 'Sports car', 'album', { typeGuessed: true, hasMbid: false, year: null }),
      row('c', 'Sports car (remixes)', 'ep'),
      // MusicBrainz has two "Violence" singles; the owned one stands for both.
      row('d', 'Violence', 'single', { year: 2019 }),
      row('e', 'Violence', 'single', { year: 2019, owned: true }),
      // An album and its title-track single are two releases.
      row('f', 'Miss Anthropocene', 'album', { year: 2020 }),
      row('g', 'Miss Anthropocene (Deluxe Edition)', 'album', { hasMbid: false, year: null }),
      row('h', 'Miss Anthropocene', 'single', { year: 2019 }),
      // Someone else's release credits the artist: listed apart, so it stays.
      row('i', 'Sports car', 'single', { led: false }),
    ]
    expect(standingRows(rows).map((one) => one.id)).toEqual(['a', 'c', 'e', 'f', 'h', 'i'])
  })

  it('leaves out a popular song’s album MusicBrainz does not list for an artist it knows', () => {
    const cyberpunk = row('a', 'Cyberpunk 2077: Radio, Vol. 2 (Original Soundtrack)', 'album', { typeGuessed: true, hasMbid: false, year: null })
    const visions = row('b', 'Visions', 'album', { year: 2012 })
    expect(standingRows([cyberpunk, visions], { fromMusicBrainz: true }).map((one) => one.id)).toEqual(['b'])
    // An artist only Deezer knows has no other discography.
    expect(standingRows([cyberpunk, visions]).map((one) => one.id)).toEqual(['a', 'b'])
  })
})
