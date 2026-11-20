import { AlbumDetail, ArtistDetail, HomeResponse, Lyrics, TrackSummariesResponse, TrackSummary } from '@squirmy/contracts'
import { eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildApp } from '../../app.js'
import { db } from '../../database/client.js'
import { albumArtists, albums, artists, likes, lyrics, playlistItems, playlists, recordings, releaseTracks, wants } from '../../database/schema.js'
import { newId } from '../../lib/ids.js'
import { body, errorCode, signIn } from '../../test/api.js'
import { createAsset, createPlay } from '../../test/catalog.js'
import { useTestDatabase } from '../../test/database.js'
import { createAlbum, createArtist } from '../../test/factories.js'
import { ensureAlbumDetail, ensureArtistDetail } from '../enrichment/detail.js'

vi.mock('../enrichment/detail.js', () => ({
  ensureAlbumDetail: vi.fn(async () => {}),
  ensureArtistDetail: vi.fn(async () => {}),
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

    const detail = body(await get(`/albums/${album.albumId}`), AlbumDetail)
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
    expect(detail.albums.map((album) => album.title)).toEqual(['Newer', 'Split', 'Older'])
    expect(detail.albums.map((album) => album.availability)).toEqual(['none', 'none', 'full'])
    expect(detail.topTracks.slice(0, 4).map((track) => track.id)).toEqual([
      second!.recordingId, first!.recordingId, third!.recordingId, newer.tracks[0]!.recordingId,
    ])
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
  })
})
