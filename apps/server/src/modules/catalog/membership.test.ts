import { AlbumDetail, AlbumPage, ArtistDetail, ArtistPage, GenrePage, HomeResponse, TrackPage, TrackSummariesResponse, UnlikeResponse } from '@squirmy/contracts'
import { eq, inArray, sql } from 'drizzle-orm'
import type { FastifyInstance, LightMyRequestResponse } from 'fastify'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { z } from 'zod'
import { buildApp } from '../../app.js'
import { db } from '../../database/client.js'
import { albums, likes, mediaFiles, playlistItems, playlists, recordingArtists } from '../../database/schema.js'
import { newId } from '../../lib/ids.js'
import { body, signIn } from '../../test/api.js'
import { createFile } from '../../test/catalog.js'
import { useTestDatabase } from '../../test/database.js'
import { createAlbum, createArtist, createLibraryRoot } from '../../test/factories.js'
import { libraryAlbumsQuery, libraryArtistsQuery, libraryTracksQuery, type LibraryShape } from './library.js'

vi.mock('../enrichment/detail.js', () => ({
  ensureAlbumDetail: vi.fn(async () => {}),
  ensureArtistDetail: vi.fn(async () => {}),
  ensureLyrics: vi.fn(async () => {}),
  albumDetailRun: vi.fn(async () => {}),
}))

type AnyPage = z.ZodObject<{ items: z.ZodArray<z.ZodType>; nextCursor: z.ZodNullable<z.ZodString> }>
type User = Awaited<ReturnType<typeof signIn>>

/**
 * Library membership (docs/architecture.md, "Availability"): the collection, which every
 * user has, plus each user's saves. Files a provider delivered are cache and put nothing
 * in a library by themselves.
 */
describe('library membership', () => {
  useTestDatabase()
  let app: FastifyInstance
  let owner: User
  let other: User
  const ids = (items: { id: string }[]) => items.map((item) => item.id)
  const fetched = 'provider:00000000-0000-7000-8000-000000000000'

  const get = (user: User, url: string) => app.inject({ url: `/api/v1${url}`, headers: user.headers })
  /** The heart: the one way to save. */
  const save = async (user: User, type: 'album' | 'track' | 'artist', id: string) => {
    expect((await app.inject({ method: 'PUT', url: `/api/v1/me/likes/${type}/${id}`, headers: user.headers })).statusCode).toBe(200)
  }
  const remove = async (user: User, type: 'album' | 'track' | 'artist', id: string) => {
    expect((await app.inject({ method: 'DELETE', url: `/api/v1/me/likes/${type}/${id}`, headers: user.headers })).statusCode).toBe(200)
  }

  async function walk<Schema extends AnyPage>(user: User, url: string, schema: Schema, limit: number) {
    const items: z.infer<Schema>['items'] = []
    let cursor: string | null = null
    for (let page = 0; page < 100; page++) {
      const separator = url.includes('?') ? '&' : '?'
      const response: LightMyRequestResponse = await get(user, `${url}${separator}limit=${limit}${cursor ? `&cursor=${cursor}` : ''}`)
      const result: z.infer<AnyPage> = body(response, schema)
      items.push(...result.items)
      cursor = result.nextCursor
      if (!cursor) return items
    }
    throw new Error('Pagination did not end')
  }
  const albumIds = async (user: User, sort = 'recent') => ids(await walk(user, `/library/albums?sort=${sort}`, AlbumPage, 200))
  const trackIds = async (user: User, sort = 'recent') => ids(await walk(user, `/library/tracks?sort=${sort}`, TrackPage, 200))
  const artistNames = async (user: User) => (await walk(user, '/library/artists', ArtistPage, 200)).map((artist) => artist.name)

  beforeAll(async () => {
    app = await buildApp()
    owner = await signIn()
    other = await signIn()
  })
  beforeEach(async () => {
    await db.delete(likes)
    await db.delete(mediaFiles)
  })
  afterAll(async () => {
    await app.close()
  })

  it('leaves everything out of the library when only provider-delivered files exist', async () => {
    const played = await createAlbum({ title: 'Sampled', owned: true, source: fetched })
    await db.update(albums).set({ genres: ['Ambient'] }).where(eq(albums.id, played.albumId))
    for (const user of [owner, other]) {
      expect(await albumIds(user)).toEqual([])
      for (const sort of ['title', 'artist', 'year']) expect(await albumIds(user, sort)).toEqual([])
      for (const sort of ['recent', 'title', 'artist', 'year']) expect(await trackIds(user, sort)).toEqual([])
      expect(await artistNames(user)).toEqual([])
      expect(body(await get(user, '/library/genres'), GenrePage).items).toEqual([])
      const home = body(await get(user, '/home'), HomeResponse)
      expect(home.sections.find((section) => section.id === 'recently-added')).toBeUndefined()
    }
    // Cached files still play: the tracks are `server`, just not in the library.
    const detail = body(await get(owner, `/albums/${played.albumId}`), AlbumDetail)
    expect(detail).toMatchObject({ availability: 'full', library: null })
    expect(detail.discs[0]!.tracks.every((track) => track.availability === 'server' && track.inLibrary === false)).toBe(true)
    expect(body(await get(owner, `/artists/${played.artist.id}`), ArtistDetail).inLibrary).toBe(false)
  })

  it('puts a saved album without files first in the saver\'s library only', async () => {
    const scanned = await createAlbum({ title: 'Scanned', owned: true })
    const wanted = await createAlbum({ title: 'Wanted' })
    await save(owner, 'album', wanted.albumId)

    const recent = body(await get(owner, '/library/albums?sort=recent&limit=1'), AlbumPage)
    expect(ids(recent.items)).toEqual([wanted.albumId])
    expect(await albumIds(owner)).toEqual([wanted.albumId, scanned.albumId])
    expect(body(await get(owner, `/albums/${wanted.albumId}`), AlbumDetail).library).toBe('saved')
    expect(await albumIds(other)).toEqual([scanned.albumId])
    expect(body(await get(other, `/albums/${wanted.albumId}`), AlbumDetail).library).toBeNull()

    const home = body(await get(owner, '/home'), HomeResponse)
    const added = home.sections.find((section) => section.id === 'recently-added')
    expect(added?.kind === 'albums' && ids(added.albums)).toEqual([wanted.albumId, scanned.albumId])
    const theirs = body(await get(other, '/home'), HomeResponse).sections.find((section) => section.id === 'recently-added')
    expect(theirs?.kind === 'albums' && ids(theirs.albums)).toEqual([scanned.albumId])

    // Its artist is a library artist for the saver only; its songs wait for their files.
    expect(await artistNames(owner)).toEqual([scanned.artist.name, wanted.artist.name].sort())
    expect(await artistNames(other)).toEqual([scanned.artist.name])
    expect(await trackIds(owner)).toEqual(ids([...scanned.tracks].reverse().map((track) => ({ id: track.recordingId }))))
    await createFile({ rootId: (await createLibraryRoot()).id, recordingId: wanted.tracks[0]!.recordingId, albumId: wanted.albumId, source: fetched })
    expect(await trackIds(owner)).toContain(wanted.tracks[0]!.recordingId)
    expect(await trackIds(other)).not.toContain(wanted.tracks[0]!.recordingId)
  })

  it('removes a save and nothing else: a song hearted on its own stays', async () => {
    const album = await createAlbum({ title: 'Kept', owned: true, source: fetched })
    const [track] = album.tracks
    await save(owner, 'album', album.albumId)
    await save(owner, 'track', track!.recordingId)
    const playlistId = newId()
    await db.insert(playlists).values({ id: playlistId, ownerId: owner.id, name: 'Mix' })
    await db.insert(playlistItems).values({ id: newId(), playlistId, position: 0, recordingId: track!.recordingId, albumId: album.albumId })
    expect(await albumIds(owner)).toEqual([album.albumId])
    expect(await trackIds(owner)).toHaveLength(3)

    await remove(owner, 'album', album.albumId)
    await remove(owner, 'album', album.albumId)
    expect(await albumIds(owner)).toEqual([])
    expect(await trackIds(owner)).toEqual([track!.recordingId])
    expect(await artistNames(owner)).toEqual([])
    expect(body(await get(owner, `/albums/${album.albumId}`), AlbumDetail).library).toBeNull()
    expect(await db.select().from(mediaFiles).where(eq(mediaFiles.albumId, album.albumId))).toHaveLength(3)
    expect(await db.select().from(likes).where(eq(likes.userId, owner.id))).toHaveLength(1)
    expect(await db.select().from(playlistItems).where(eq(playlistItems.playlistId, playlistId))).toHaveLength(1)
  })

  it('shares scanned and uploaded albums with every user as the collection', async () => {
    const scanned = await createAlbum({ title: 'From disk', owned: true })
    const uploaded = await createAlbum({ title: 'From upload', owned: [0], source: 'upload' })
    await save(owner, 'album', scanned.albumId)
    for (const user of [owner, other]) {
      expect((await albumIds(user, 'title')).sort()).toEqual([scanned.albumId, uploaded.albumId].sort())
      // A collection album is the collection's even when also saved: it cannot be removed.
      for (const album of [scanned, uploaded]) expect(body(await get(user, `/albums/${album.albumId}`), AlbumDetail).library).toBe('collection')
    }
    // Only the uploaded album's one file is collection; its other tracks are not library tracks.
    const tracks = body(await get(other, `/albums/${uploaded.albumId}`), AlbumDetail).discs[0]!.tracks
    expect(tracks.map((track) => track.inLibrary)).toEqual([true, false, false])
  })

  it('adds a saved track to Songs without adding its album', async () => {
    const album = await createAlbum({ title: 'Single source' })
    const [track] = album.tracks
    await save(owner, 'track', track!.recordingId)
    await save(owner, 'track', track!.recordingId)
    expect(await trackIds(owner)).toEqual([track!.recordingId])
    for (const sort of ['title', 'artist']) expect(await trackIds(owner, sort)).toEqual([track!.recordingId])
    // By year a track is placed by its file's album, so a saved one waits for its file.
    expect(await trackIds(owner, 'year')).toEqual([])
    await createFile({ rootId: (await createLibraryRoot()).id, recordingId: track!.recordingId, albumId: album.albumId, source: fetched })
    expect(await trackIds(owner, 'year')).toEqual([track!.recordingId])
    expect(await albumIds(owner)).toEqual([])
    expect(await artistNames(owner)).toEqual([])
    expect(await trackIds(other)).toEqual([])
    const summaries = body(await app.inject({
      method: 'POST', url: '/api/v1/tracks/summaries', headers: owner.headers, payload: { tracks: album.tracks.map((one) => ({ id: one.recordingId })) },
    }), TrackSummariesResponse)
    expect(summaries.tracks.map((one) => one.inLibrary)).toEqual([true, false, false])
    expect(summaries.tracks.map((one) => one.library)).toEqual(['saved', null, null])
    await remove(owner, 'track', track!.recordingId)
    expect(await trackIds(owner)).toEqual([])
  })

  it('says why a track is in the library, so clients offer Remove only for the user\'s own save', async () => {
    const scanned = await createAlbum({ title: 'On disk', owned: true })
    const kept = await createAlbum({ title: 'Kept for later', owned: true, source: fetched })
    const loose = await createAlbum({ title: 'Loose', owned: true, source: fetched })
    // Saving a collection track, or a track of a saved album, does not make it removable: it stays either way.
    await save(owner, 'track', scanned.tracks[0]!.recordingId)
    await save(owner, 'album', kept.albumId)
    await save(owner, 'track', kept.tracks[0]!.recordingId)
    await save(owner, 'track', loose.tracks[0]!.recordingId)
    const library = async (user: User, tracks: { recordingId: string }[]) => body(await app.inject({
      method: 'POST', url: '/api/v1/tracks/summaries', headers: user.headers, payload: { tracks: tracks.map((one) => ({ id: one.recordingId })) },
    }), TrackSummariesResponse).tracks.map((one) => one.library)

    expect(await library(owner, scanned.tracks)).toEqual(['collection', 'collection', 'collection'])
    expect(await library(owner, kept.tracks)).toEqual(['album', 'album', 'album'])
    expect(await library(owner, loose.tracks)).toEqual(['saved', null, null])
    expect(await library(other, [...scanned.tracks, ...kept.tracks, ...loose.tracks]))
      .toEqual(['collection', 'collection', 'collection', null, null, null, null, null, null])
  })

  it('pages through recent albums mixing the collection and saves, each once and in order', async () => {
    const root = (await createLibraryRoot()).id
    const minute = (n: number) => new Date(Date.UTC(2026, 0, 1, 0, n))
    const created: Record<string, string> = {}
    for (const [name, files, savedAt] of [
      ['c1', [1], null], ['s2', [], 2], ['c3', [3, 3], null], ['s4', [], 4], ['both5', [5], 3],
      ['both6', [1], 6], ['tie7', [7], 7], ['s7', [], 7], ['c7', [7], null], ['cached8', [], null],
    ] as const) {
      const album = await createAlbum({ title: name, tracks: [{ title: `${name} a` }, { title: `${name} b` }] })
      created[name] = album.albumId
      for (const [index, at] of files.entries()) {
        await createFile({ rootId: root, recordingId: album.tracks[index]!.recordingId, albumId: album.albumId, addedAt: minute(at) })
      }
      if (savedAt !== null) await db.insert(likes).values({ userId: owner.id, entityType: 'album', entityId: album.albumId, createdAt: minute(savedAt) })
      if (name === 'cached8') await createFile({ rootId: root, recordingId: album.tracks[0]!.recordingId, albumId: album.albumId, addedAt: minute(8), source: fetched })
    }
    // Later of newest collection file and save; ties by album id, newest first.
    const order = (times: Record<string, number>) => Object.entries(times)
      .sort(([a, x], [b, y]) => y - x || (created[b]! > created[a]! ? 1 : -1)).map(([name]) => created[name]!)
    const names = (list: string[]) => list.map((id) => Object.keys(created).find((name) => created[name] === id) ?? id)
    const expected = order({ c1: 1, s2: 2, c3: 3, s4: 4, both5: 5, both6: 6, tie7: 7, s7: 7, c7: 7 })
    for (const limit of [1, 2, 3, 4, 200]) {
      expect(names(ids(await walk(owner, '/library/albums?sort=recent', AlbumPage, limit))), `by ${limit}`).toEqual(names(expected))
    }
    // Without the saves only the collection's times count.
    expect(ids(await walk(other, '/library/albums?sort=recent', AlbumPage, 2))).toEqual(order({ c1: 1, c3: 3, both5: 5, both6: 1, tie7: 7, c7: 7 }))
  })

  it('puts a removed save back in its place on Undo, with the time the removal answered', async () => {
    const [older, newer] = [await createAlbum({ title: 'Older' }), await createAlbum({ title: 'Newer' })]
    await db.insert(likes).values([
      { userId: owner.id, entityType: 'album', entityId: older.albumId, createdAt: new Date('2026-01-01T00:00:00Z') },
      { userId: owner.id, entityType: 'album', entityId: newer.albumId, createdAt: new Date('2026-02-01T00:00:00Z') },
    ])
    const removed = await app.inject({ method: 'DELETE', url: `/api/v1/me/likes/album/${older.albumId}`, headers: owner.headers })
    const { savedAt } = body(removed, UnlikeResponse)
    expect(savedAt).toBe('2026-01-01T00:00:00.000Z')
    expect(body(await app.inject({ method: 'DELETE', url: `/api/v1/me/likes/album/${older.albumId}`, headers: owner.headers }), UnlikeResponse).savedAt).toBeNull()
    await app.inject({ method: 'PUT', url: `/api/v1/me/likes/album/${older.albumId}?savedAt=${encodeURIComponent(savedAt!)}`, headers: owner.headers })
    expect(await albumIds(owner)).toEqual([newer.albumId, older.albumId])
    // A time from the future is taken as now: it cannot pin an item to the top.
    await remove(owner, 'album', older.albumId)
    await app.inject({ method: 'PUT', url: `/api/v1/me/likes/album/${older.albumId}?savedAt=2099-01-01T00:00:00Z`, headers: owner.headers })
    const [row] = await db.select().from(likes).where(eq(likes.entityId, older.albumId))
    expect(row!.createdAt.getTime()).toBeLessThanOrEqual(Date.now())
  })

  it('lists a saved album\'s songs in track order in recent tracks, page after page', async () => {
    const album = await createAlbum({ title: 'In Order', owned: true, source: fetched,
      tracks: [{ title: 'First' }, { title: 'Second' }, { title: 'Third' }, { title: 'Fourth' }] })
    await save(owner, 'album', album.albumId)
    for (const limit of [1, 3, 10]) {
      expect(ids(await walk(owner, '/library/tracks?sort=recent', TrackPage, limit)), `by ${limit}`)
        .toEqual(album.tracks.map((track) => track.recordingId))
    }
  })

  it('places each track once in recent tracks by the latest way it entered the library', async () => {
    const root = (await createLibraryRoot()).id
    const minute = (n: number) => new Date(Date.UTC(2026, 0, 1, 0, n))
    const album = await createAlbum({ title: 'Ways in', tracks: [{ title: 'one' }, { title: 'two' }, { title: 'three' }, { title: 'four' }] })
    const [one, two, three, four] = album.tracks.map((track) => track.recordingId)
    const other1 = await createAlbum({ title: 'Elsewhere', tracks: [{ title: 'also two' }] })
    // one: collection at 1, saved itself at 5. two: collection at 9 and on the album saved at 3.
    // three: cached file on the album saved at 3. four: cached, on no saved album, saved itself at 2.
    await createFile({ rootId: root, recordingId: one!, albumId: album.albumId, addedAt: minute(1) })
    await createFile({ rootId: root, recordingId: two!, albumId: other1.albumId, addedAt: minute(9) })
    await createFile({ rootId: root, recordingId: two!, albumId: album.albumId, addedAt: minute(2), source: fetched })
    await createFile({ rootId: root, recordingId: three!, albumId: album.albumId, addedAt: minute(0), source: fetched })
    await createFile({ rootId: root, recordingId: four!, albumId: other1.albumId, addedAt: minute(0), source: fetched })
    await db.insert(likes).values([
      { userId: owner.id, entityType: 'recording', entityId: one!, createdAt: minute(5) },
      { userId: owner.id, entityType: 'album', entityId: album.albumId, createdAt: minute(3) },
      { userId: owner.id, entityType: 'recording', entityId: four!, createdAt: minute(2) },
    ])
    for (const limit of [1, 2, 10]) {
      const tracks = await walk(owner, '/library/tracks?sort=recent', TrackPage, limit)
      expect(ids(tracks), `by ${limit}`).toEqual([two, one, three, four])
      // Each is shown in the album that put it there: the collection file's, the saved one.
      expect(tracks.map((track) => track.album?.id)).toEqual([other1.albumId, album.albumId, album.albumId, other1.albumId])
    }
    expect(await trackIds(other)).toEqual([two, one])
  })

  it('puts a hearted artist in the library without any album of theirs', async () => {
    const followed = await createArtist({ name: 'Followed' })
    await createAlbum({ artist: followed, title: 'Not Saved', owned: true, source: fetched })
    expect(await artistNames(owner)).toEqual([])
    await save(owner, 'artist', followed.id)
    expect(await artistNames(owner)).toEqual(['Followed'])
    expect(await artistNames(other)).toEqual([])
    expect(body(await get(owner, `/artists/${followed.id}`), ArtistDetail)).toMatchObject({ liked: true, inLibrary: true })
    // An artist's save leaves its albums where they were.
    expect(await albumIds(owner)).toEqual([])
    await remove(owner, 'artist', followed.id)
    expect(await artistNames(owner)).toEqual([])
    expect(body(await get(owner, `/artists/${followed.id}`), ArtistDetail)).toMatchObject({ liked: false, inLibrary: false })
  })

  it('keeps the old Add to library routes as the heart, for older apps', async () => {
    const album = await createAlbum({ title: 'Old App', owned: true, source: fetched })
    expect((await app.inject({ method: 'PUT', url: `/api/v1/me/library/album/${album.albumId}`, headers: owner.headers })).statusCode).toBe(200)
    expect(body(await get(owner, `/albums/${album.albumId}`), AlbumDetail)).toMatchObject({ liked: true, library: 'saved' })
    expect(await albumIds(owner)).toEqual([album.albumId])
    expect((await app.inject({ method: 'DELETE', url: `/api/v1/me/library/album/${album.albumId}`, headers: owner.headers })).statusCode).toBe(200)
    expect(body(await get(owner, `/albums/${album.albumId}`), AlbumDetail)).toMatchObject({ liked: false, library: null })
  })

  it('counts an artist only when credited on a library album, not featured on a track', async () => {
    const lead = await createArtist({ name: 'Lead' })
    const guest = await createArtist({ name: 'Guest' })
    const album = await createAlbum({ artist: lead, title: 'Features', owned: true })
    await db.insert(recordingArtists).values({ recordingId: album.tracks[0]!.recordingId, position: 1, artistId: guest.id, creditedName: 'Guest' })
    expect(await artistNames(owner)).toEqual(['Lead'])
    expect(body(await get(owner, `/artists/${guest.id}`), ArtistDetail).inLibrary).toBe(false)
    expect(body(await get(owner, `/artists/${lead.id}`), ArtistDetail).inLibrary).toBe(true)
  })

  it('answers the same whether a page is read from the members or the catalog index', async () => {
    const root = (await createLibraryRoot()).id
    const zed = await createArtist({ name: 'Zed' })
    const made = [
      await createAlbum({ artist: zed, title: 'Same', year: 2001, owned: true }),
      await createAlbum({ title: 'The Beta', year: 1999, owned: [1] }),
      await createAlbum({ title: 'Alpha', year: 2010 }),
      await createAlbum({ title: 'Cached', year: 2005, owned: true, source: fetched }),
      await createAlbum({ title: 'Gone', owned: true }),
    ]
    await db.update(mediaFiles).set({ missingSince: new Date() }).where(eq(mediaFiles.albumId, made[4]!.albumId))
    await db.update(albums).set({ genres: ['Jazz'] }).where(inArray(albums.id, made.map((album) => album.albumId)))
    await save(owner, 'album', made[2]!.albumId)
    await save(owner, 'album', made[3]!.albumId)
    await save(owner, 'track', made[1]!.tracks[0]!.recordingId)
    await createFile({ rootId: root, recordingId: made[2]!.tracks[0]!.recordingId, albumId: made[2]!.albumId, source: fetched })

    const run = async (query: (shape: LibraryShape) => ReturnType<typeof libraryAlbumsQuery>) => {
      const [small, large] = await Promise.all((['small', 'large'] as const).map(async (shape) => (await db.execute<{ id: string }>(query(shape))).map((row) => row.id)))
      expect(small).toEqual(large)
      return small!
    }
    for (const sort of ['title', 'artist', 'year'] as const) {
      expect(await run((shape) => libraryAlbumsQuery(owner.id, { sort, limit: 50 }, shape))).toHaveLength(4)
      expect(await run((shape) => libraryAlbumsQuery(owner.id, { sort, genre: 'jazz', limit: 50 }, shape))).toHaveLength(4)
      expect(await run((shape) => libraryAlbumsQuery(other.id, { sort, limit: 50 }, shape))).toHaveLength(2)
    }
    // By year, only tracks with a present file: all but The Beta's saved track without one.
    expect(await run((shape) => libraryTracksQuery(owner.id, { sort: 'year', limit: 50 }, shape))).toHaveLength(8)
    expect(await run((shape) => libraryTracksQuery(other.id, { sort: 'year', limit: 50 }, shape))).toHaveLength(4)
    for (const sort of ['title', 'artist'] as const) {
      // Same's 3, The Beta's file and its saved track, Alpha's fetched one, Cached's 3.
      expect(await run((shape) => libraryTracksQuery(owner.id, { sort, limit: 50 }, shape))).toHaveLength(9)
      expect(await run((shape) => libraryTracksQuery(other.id, { sort, limit: 50 }, shape))).toHaveLength(4)
    }
    expect(await run((shape) => libraryArtistsQuery(owner.id, { limit: 50 }, shape))).toHaveLength(4)
    expect(await run((shape) => libraryArtistsQuery(other.id, { limit: 50 }, shape))).toHaveLength(2)
  })

  it('rejects cursors of the recent order from before saves', async () => {
    await createAlbum({ owned: true })
    await createAlbum({ owned: true })
    const old = Buffer.from(JSON.stringify({ o: 'albums:recent', k: ['2026-01-01 00:00:00+00', newId()] })).toString('base64url')
    expect((await get(owner, `/library/albums?cursor=${old}`)).json()).toMatchObject({ error: { code: 'invalid_cursor' } })
    const oldTracks = Buffer.from(JSON.stringify({ o: 'tracks:recent', k: ['2026-01-01 00:00:00+00', newId()] })).toString('base64url')
    expect((await get(owner, `/library/tracks?cursor=${oldTracks}`)).json()).toMatchObject({ error: { code: 'invalid_cursor' } })
    expect(await db.execute(sql`select 1`)).toHaveLength(1)
  })
})
