import { ArtistDetail, RadioResponse } from '@squirmy/contracts'
import { eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildApp } from '../../app.js'
import { db } from '../../database/client.js'
import { albums, recordingArtists, recordings, releaseTracks } from '../../database/schema.js'
import { newId } from '../../lib/ids.js'
import { updateServerSettings } from '../../lib/settings.js'
import { body, errorCode, signIn } from '../../test/api.js'
import { useTestDatabase } from '../../test/database.js'
import { createAlbum, createArtist } from '../../test/factories.js'
import { ensureAlbumDetail } from '../enrichment/detail.js'

// What a provider covers, and whether it is one that plays albums before their track lists are known.
const coverage = vi.hoisted(() => ({ onDemand: new Set<string>(), tracklessAlbums: false }))
vi.mock('../acquisition/coverage.js', () => ({
  onDemandRecordings: vi.fn(async (ids: readonly string[]) => new Set(ids.filter((id) => coverage.onDemand.has(id)))),
  albumCoveredWithoutTracks: vi.fn(async () => coverage.tracklessAlbums),
  requestRecording: vi.fn(async () => {}),
}))
// Fetching a track list writes one covered track onto the album, as a source would.
vi.mock('../enrichment/detail.js', () => ({
  artistRadioTracks: vi.fn(async () => []),
  ensureArtistDetail: vi.fn(async () => true),
  ensureLyrics: vi.fn(async () => {}),
  ensureAlbumDetail: vi.fn(async (albumId: string) => {
    const [album] = await db.select().from(albums).where(eq(albums.id, albumId))
    const recordingId = newId()
    await db.insert(recordings).values({
      id: recordingId, title: 'Fetched', artistCredit: album!.artistCredit, primaryArtistId: album!.primaryArtistId,
      durationMs: 200_000, titleKey: 'fetched', matchKey: `${album!.artistCredit}-fetched`,
    })
    await db.insert(recordingArtists).values({ recordingId, position: 0, artistId: album!.primaryArtistId!, creditedName: album!.artistCredit })
    await db.insert(releaseTracks).values({ id: newId(), releaseId: album!.canonicalReleaseId!, disc: 1, position: 1, recordingId, title: 'Fetched', durationMs: 200_000 })
    coverage.onDemand.add(recordingId)
    return true
  }),
}))

describe('radio from music on demand', () => {
  useTestDatabase()
  let app: FastifyInstance

  beforeAll(async () => {
    await updateServerSettings({ deezerEnabled: false })
    app = await buildApp()
  })
  afterAll(async () => {
    await app.close()
  })
  beforeEach(() => {
    coverage.onDemand.clear()
    coverage.tracklessAlbums = false
    vi.mocked(ensureAlbumDetail).mockClear()
  })

  /** An artist none of whose music is on the server, with a provider covering all of it. */
  async function streamedArtist(name: string) {
    const artist = await createArtist({ name })
    const album = await createAlbum({ artist, tracks: ['One', 'Two', 'Three', 'Four'].map((title) => ({ title })) })
    for (const track of album.tracks) coverage.onDemand.add(track.recordingId)
    const hit = album.tracks[2]!.recordingId
    await db.update(recordings).set({ popularity: 1 }).where(eq(recordings.id, hit))
    return { artist, album, hit }
  }

  type Headers = Record<string, string>
  const page = async (headers: Headers, id: string) => body(await app.inject({ url: `/api/v1/artists/${id}`, headers }), ArtistDetail)
  const radio = async (headers: Headers, kind: 'artist' | 'track', id: string) => app.inject({ method: 'POST', url: `/api/v1/radio/${kind}/${id}`, headers })

  it('starts a requester\'s artist radio from its most popular track when nothing is on the server', async () => {
    const requester = await signIn({ canAcquire: true })
    const { artist, album, hit } = await streamedArtist('Streamed')
    expect((await page(requester.headers, artist.id)).radio).toBe(true)
    const response = body(await radio(requester.headers, 'artist', artist.id), RadioResponse)
    expect(response.context).toEqual({ type: 'radio', id: `artist:${artist.id}`, title: 'Streamed' })
    expect(response.tracks[0]).toMatchObject({ trackId: hit, albumId: album.albumId, state: 'preparing' })
    // The rest come from the artist's catalog too, fetched as they play.
    const rest = response.tracks.slice(1)
    expect(rest.length).toBeGreaterThan(0)
    expect(rest.every((track) => track.state === 'preparing' && album.tracks.some((one) => one.recordingId === track.trackId))).toBe(true)
  })

  it('starts from an owned track when the artist has one, so the radio plays at once', async () => {
    const requester = await signIn({ role: 'admin' })
    const { artist } = await streamedArtist('Partly here')
    const owned = await createAlbum({ artist, owned: true, tracks: [{ title: 'Here' }] })
    const response = body(await radio(requester.headers, 'artist', artist.id), RadioResponse)
    expect(response.tracks[0]).toMatchObject({ trackId: owned.tracks[0]!.recordingId, state: 'ready' })
  })

  it('is not offered to, and does not start for, someone who may not fetch', async () => {
    const member = await signIn()
    const { artist, hit } = await streamedArtist('Out of reach')
    expect((await page(member.headers, artist.id)).radio).toBe(false)
    expect(errorCode(await radio(member.headers, 'artist', artist.id), 409)).toBe('nothing_playable')
    // The same rule for a radio from one of its tracks, as from a search result.
    expect(errorCode(await radio(member.headers, 'track', hit), 409)).toBe('not_playable')
  })

  it('starts a requester\'s radio from an on-demand track', async () => {
    const requester = await signIn({ canAcquire: true })
    const { hit } = await streamedArtist('One track')
    const response = body(await radio(requester.headers, 'track', hit), RadioResponse)
    expect(response.tracks[0]).toMatchObject({ trackId: hit, state: 'preparing' })
  })

  it('fetches a track list first for an artist known only by its albums', async () => {
    const requester = await signIn({ canAcquire: true })
    const artist = await createArtist({ name: 'Only albums' })
    // Found by search: albums with no track list yet.
    const single = await createAlbum({ artist, type: 'single', year: 2024, tracks: [] })
    const studio = await createAlbum({ artist, year: 2001, tracks: [] })

    // A provider that needs a track list to know what it has offers nothing here.
    expect((await page(requester.headers, artist.id)).radio).toBe(false)
    expect(errorCode(await radio(requester.headers, 'artist', artist.id), 409)).toBe('nothing_playable')
    expect(ensureAlbumDetail).not.toHaveBeenCalled()

    coverage.tracklessAlbums = true
    expect((await page(requester.headers, artist.id)).radio).toBe(true)
    vi.mocked(ensureAlbumDetail).mockClear()
    const response = body(await radio(requester.headers, 'artist', artist.id), RadioResponse)
    // Studio albums first, then the rest, newest first.
    expect(vi.mocked(ensureAlbumDetail).mock.calls.map(([id]) => id)).toEqual([studio.albumId, single.albumId])
    expect(response.tracks[0]!.state).toBe('preparing')
    expect(coverage.onDemand.has(response.tracks[0]!.trackId)).toBe(true)
  })
})
