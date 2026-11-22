import {
  AlbumDetail, AlbumPage, ArtistPage, HistoryPage, Ok, PlaylistDetail, PlaylistPage, PlaylistSummary, queryKeys, TrackPage, TrackSummary, UserSettings, WantPage,
} from '@squirmy/contracts'
import { and, asc, eq } from 'drizzle-orm'
import type { FastifyInstance, InjectOptions } from 'fastify'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildApp } from '../../app.js'
import { db } from '../../database/client.js'
import { albums, assets, playlistItems, recordings, users, wants } from '../../database/schema.js'
import { newId } from '../../lib/ids.js'
import { updateServerSettings } from '../../lib/settings.js'
import { invalidate } from '../../realtime/index.js'
import { body, errorCode, signIn } from '../../test/api.js'
import { createAsset, createFile, createPlay } from '../../test/catalog.js'
import { useTestDatabase } from '../../test/database.js'
import { createAlbum, createLibraryRoot } from '../../test/factories.js'
import { getRatings, setRating } from './likes.js'
import { refreshWants } from './wants.js'

vi.mock('../../realtime/index.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../realtime/index.js')>(),
  invalidate: vi.fn(async () => {}),
}))
const invalidated = vi.mocked(invalidate)

describe('userdata', () => {
  useTestDatabase()
  let app: FastifyInstance
  let mira: Awaited<ReturnType<typeof signIn>>
  let lune: Awaited<ReturnType<typeof signIn>>

  const call = (who: { headers: Record<string, string> }, options: InjectOptions) =>
    app.inject({ ...options, url: `/api/v1${options.url as string}`, headers: who.headers })

  beforeAll(async () => {
    app = await buildApp()
    mira = await signIn({ username: 'mira' })
    lune = await signIn({ username: 'lune' })
  })
  beforeEach(() => invalidated.mockClear())
  afterAll(async () => {
    await app.close()
  })

  describe('likes', () => {
    it('likes, lists newest first, and unlikes tracks, albums and artists', async () => {
      const album = await createAlbum({ owned: [0] })
      const [first, second, third] = album.tracks.map((track) => track.recordingId)
      for (const id of [first, second, third]) {
        body(await call(mira, { method: 'PUT', url: `/me/likes/track/${id}` }), Ok)
      }
      // Liking twice is harmless.
      body(await call(mira, { method: 'PUT', url: `/me/likes/track/${first}` }), Ok)
      body(await call(mira, { method: 'PUT', url: `/me/likes/album/${album.albumId}` }), Ok)
      body(await call(mira, { method: 'PUT', url: `/me/likes/artist/${album.artist.id}` }), Ok)

      const pages: string[] = []
      let cursor: string | null = null
      do {
        const page: TrackPage = body(await call(mira, { url: `/me/likes/track?limit=2${cursor ? `&cursor=${cursor}` : ''}` }), TrackPage)
        pages.push(...page.items.map((track) => track.id))
        expect(page.items.every((track) => track.liked)).toBe(true)
        cursor = page.nextCursor
      } while (cursor)
      expect(pages).toEqual([third, second, first])
      expect(body(await call(mira, { url: '/me/likes/album' }), AlbumPage).items.map((item) => item.id)).toEqual([album.albumId])
      expect(body(await call(mira, { url: '/me/likes/artist' }), ArtistPage).items.map((item) => item.id)).toEqual([album.artist.id])
      // Likes are per user.
      expect(body(await call(lune, { url: '/me/likes/track' }), TrackPage).items).toEqual([])
      expect(body(await call(lune, { url: `/tracks/${first}` }), TrackSummary).liked).toBe(false)

      body(await call(mira, { method: 'DELETE', url: `/me/likes/track/${second}` }), Ok)
      body(await call(mira, { method: 'DELETE', url: `/me/likes/track/${second}` }), Ok)
      expect(body(await call(mira, { url: '/me/likes/track' }), TrackPage).items.map((track) => track.id)).toEqual([third, first])
    })

    it('tells the user\'s other devices what changed', async () => {
      const album = await createAlbum()
      const track = album.tracks[0]!.recordingId
      await call(mira, { method: 'PUT', url: `/me/likes/track/${track}` })
      expect(invalidated).toHaveBeenCalledTimes(1)
      const [target, keys] = invalidated.mock.calls[0]!
      expect(target).toEqual({ user: mira.id })
      expect(keys).toEqual(expect.arrayContaining([
        queryKeys.likes(), queryKeys.track(track), queryKeys.album(album.albumId), queryKeys.artist(album.artist.id), queryKeys.history(),
        // Songs lists and search results show the heart too.
        queryKeys.libraryTracks(), queryKeys.search(),
      ]))
      // The playlists list shows no hearts: only playlists holding the track are refreshed.
      expect(keys).not.toContainEqual(queryKeys.playlists())
      const holding = body(await call(mira, { method: 'POST', url: '/playlists', payload: { name: 'Holding' } }), PlaylistSummary, 201)
      await call(mira, { method: 'POST', url: `/playlists/${holding.id}/items`, payload: { tracks: [{ trackId: track }] } })
      const other = body(await call(lune, { method: 'POST', url: '/playlists', payload: { name: 'Private elsewhere' } }), PlaylistSummary, 201)
      await call(lune, { method: 'POST', url: `/playlists/${other.id}/items`, payload: { tracks: [{ trackId: track }] } })
      invalidated.mockClear()
      await call(mira, { method: 'DELETE', url: `/me/likes/track/${track}` })
      const [, unliked] = invalidated.mock.calls[0]!
      expect(unliked).toContainEqual(queryKeys.playlist(holding.id))
      expect(unliked).not.toContainEqual(queryKeys.playlist(other.id))
      invalidated.mockClear()
      await call(mira, { method: 'PUT', url: `/me/likes/album/${album.albumId}` })
      expect(invalidated).toHaveBeenCalledWith({ user: mira.id }, [queryKeys.likes(), queryKeys.home(), queryKeys.album(album.albumId)])
    })

    it('refreshes the album a liked bonus track is filed under', async () => {
      const album = await createAlbum({ owned: true })
      // A recording the album's release does not list, owned through a file filed under the album.
      const bonus = (await createAlbum({ tracks: [{ title: 'Hidden Track' }] })).tracks[0]!.recordingId
      await createFile({ rootId: (await createLibraryRoot()).id, recordingId: bonus, albumId: album.albumId })
      await call(mira, { method: 'PUT', url: `/me/likes/track/${bonus}` })
      expect(invalidated.mock.calls[0]![1]).toEqual(expect.arrayContaining([queryKeys.album(album.albumId)]))
    })

    it('stores likes against the surviving row of a merge', async () => {
      const winner = await createAlbum()
      const loser = await createAlbum()
      await db.update(albums).set({ mergedIntoId: winner.albumId }).where(eq(albums.id, loser.albumId))
      body(await call(lune, { method: 'PUT', url: `/me/likes/album/${loser.albumId}` }), Ok)
      expect(body(await call(lune, { url: '/me/likes/album' }), AlbumPage).items.map((item) => item.id)).toEqual([winner.albumId])
      body(await call(lune, { method: 'DELETE', url: `/me/likes/album/${loser.albumId}` }), Ok)
      expect(body(await call(lune, { url: '/me/likes/album' }), AlbumPage).items).toEqual([])
    })

    it('rejects unknown entities and types', async () => {
      expect(errorCode(await call(mira, { method: 'PUT', url: `/me/likes/track/${newId()}` }), 404)).toBe('track_not_found')
      expect(errorCode(await call(mira, { method: 'PUT', url: `/me/likes/song/${newId()}` }), 400)).toBe('invalid_request')
      expect(errorCode(await call(mira, { url: '/me/likes/recording' }), 400)).toBe('invalid_request')
      expect(errorCode(await app.inject({ url: '/api/v1/me/likes/track' }), 401)).toBe('unauthorized')
    })

    it('sets and reads ratings', async () => {
      const album = await createAlbum()
      const track = album.tracks[0]!.recordingId
      await setRating(mira.id, 'track', track, 4)
      await setRating(mira.id, 'track', track, 5)
      await setRating(mira.id, 'album', album.albumId, 2)
      expect(await getRatings(mira.id, 'track', [track, album.tracks[1]!.recordingId])).toEqual(new Map([[track, 5]]))
      expect(await getRatings(lune.id, 'track', [track])).toEqual(new Map())
      await setRating(mira.id, 'track', track, 0)
      expect(await getRatings(mira.id, 'track', [track])).toEqual(new Map())
      await expect(setRating(mira.id, 'track', track, 6)).rejects.toMatchObject({ code: 'invalid_rating' })
      await expect(setRating(mira.id, 'artist', newId(), 3)).rejects.toMatchObject({ code: 'artist_not_found' })
    })
  })

  describe('playlists', () => {
    const create = async (who: typeof mira, payload: object) =>
      body(await call(who, { method: 'POST', url: '/playlists', payload }), PlaylistSummary, 201)
    const add = (who: typeof mira, id: string, payload: object) => call(who, { method: 'POST', url: `/playlists/${id}/items`, payload })
    const positions = async (playlistId: string) =>
      (await db.select().from(playlistItems).where(eq(playlistItems.playlistId, playlistId)).orderBy(asc(playlistItems.position))).map((item) => item.position)

    it('creates, lists, reads and updates playlists with owner-only changes', async () => {
      const mine = await create(mira, { name: 'Morning', description: 'Slow start' })
      expect(mine).toMatchObject({ name: 'Morning', description: 'Slow start', ownerId: mira.id, ownerName: 'mira', isPublic: false, trackCount: 0, durationMs: 0, artworks: [] })
      expect(invalidated).toHaveBeenCalledWith({ user: mira.id }, [queryKeys.playlists(), queryKeys.home()])
      invalidated.mockClear()
      const shared = await create(lune, { name: 'Shared', isPublic: true })
      // Everyone refreshes the list once, the owner included (they are in 'all' too).
      expect(invalidated.mock.calls).toEqual([[[{ user: lune.id }, 'all'], [queryKeys.playlists()]], [{ user: lune.id }, [queryKeys.home()]]])
      const secret = await create(lune, { name: 'Secret' })

      const visible = body(await call(mira, { url: '/playlists' }), PlaylistPage).items.map((playlist) => playlist.name)
      expect(visible).toEqual(expect.arrayContaining(['Morning', 'Shared']))
      expect(visible).not.toContain('Secret')

      expect(body(await call(mira, { url: `/playlists/${shared.id}` }), PlaylistDetail).name).toBe('Shared')
      expect(errorCode(await call(mira, { url: `/playlists/${secret.id}` }), 404)).toBe('playlist_not_found')
      expect(errorCode(await call(mira, { method: 'PATCH', url: `/playlists/${secret.id}`, payload: { name: 'x' } }), 404)).toBe('playlist_not_found')
      expect(errorCode(await call(mira, { method: 'PATCH', url: `/playlists/${shared.id}`, payload: { name: 'Mine now' } }), 403)).toBe('forbidden')
      expect(errorCode(await add(mira, shared.id, { tracks: [{ trackId: newId() }] }), 403)).toBe('forbidden')
      expect(errorCode(await call(mira, { method: 'DELETE', url: `/playlists/${shared.id}` }), 403)).toBe('forbidden')
      expect(errorCode(await call(mira, { method: 'POST', url: '/playlists', payload: { name: '  ' } }), 400)).toBe('invalid_request')

      const updated = body(await call(mira, { method: 'PATCH', url: `/playlists/${mine.id}`, payload: { name: 'Evening', isPublic: true } }), PlaylistSummary)
      expect(updated).toMatchObject({ name: 'Evening', description: 'Slow start', isPublic: true })
      expect(body(await call(lune, { url: `/playlists/${mine.id}` }), PlaylistDetail).name).toBe('Evening')

      body(await call(lune, { method: 'DELETE', url: `/playlists/${secret.id}` }), Ok)
      expect(errorCode(await call(lune, { url: `/playlists/${secret.id}` }), 404)).toBe('playlist_not_found')
    })

    it('adds, moves and removes items, keeping unowned tracks', async () => {
      const owned = await createAlbum({ owned: true })
      const catalogOnly = await createAlbum()
      const cover = await createAsset()
      await db.update(albums).set({ artworkAssetId: cover.id }).where(eq(albums.id, owned.albumId))
      const playlist = await create(mira, { name: 'Mix' })
      const [a, b, c] = owned.tracks.map((track) => track.recordingId)
      const gray = catalogOnly.tracks[0]!.recordingId

      let detail = body(await add(mira, playlist.id, { tracks: [{ trackId: a }, { trackId: gray }, { trackId: b, albumId: owned.albumId }] }), PlaylistDetail)
      expect(detail.items.map((item) => [item.track.id, item.track.availability])).toEqual([[a, 'server'], [gray, 'none'], [b, 'server']])
      expect(detail).toMatchObject({ trackCount: 3, artworks: [{ id: cover.id }] })
      expect(detail.durationMs).toBe(owned.tracks[0]!.durationMs + owned.tracks[1]!.durationMs + catalogOnly.tracks[0]!.durationMs)
      // The album a track was added from is remembered even when the client sent none.
      expect(detail.items[1]!.track.album?.id).toBe(catalogOnly.albumId)

      detail = body(await add(mira, playlist.id, { tracks: [{ trackId: a }, { trackId: c }, { trackId: c }] }), PlaylistDetail)
      expect(detail.items.map((item) => item.track.id)).toEqual([a, gray, b, a, c, c])
      detail = body(await add(mira, playlist.id, { tracks: [{ trackId: a }, { trackId: c }], skipDuplicates: true }), PlaylistDetail)
      expect(detail.items).toHaveLength(6)
      expect(errorCode(await add(mira, playlist.id, { tracks: [{ trackId: a }, { trackId: newId() }] }), 400)).toBe('track_not_found')
      expect(errorCode(await add(mira, playlist.id, { tracks: [] }), 400)).toBe('invalid_request')

      const move = (itemId: string, toIndex: number) => call(mira, { method: 'POST', url: `/playlists/${playlist.id}/items/move`, payload: { itemId, toIndex } })
      detail = body(await move(detail.items[0]!.itemId, 3), PlaylistDetail)
      expect(detail.items.map((item) => item.track.id)).toEqual([gray, b, a, a, c, c])
      detail = body(await move(detail.items[4]!.itemId, 0), PlaylistDetail)
      expect(detail.items.map((item) => item.track.id)).toEqual([c, gray, b, a, a, c])
      detail = body(await move(detail.items[0]!.itemId, 99), PlaylistDetail)
      expect(detail.items.map((item) => item.track.id)).toEqual([gray, b, a, a, c, c])
      expect(errorCode(await move(newId(), 0), 404)).toBe('playlist_item_not_found')

      detail = body(await call(mira, { method: 'DELETE', url: `/playlists/${playlist.id}/items/${detail.items[1]!.itemId}` }), PlaylistDetail)
      expect(detail.items.map((item) => item.track.id)).toEqual([gray, a, a, c, c])
      expect(await positions(playlist.id)).toEqual([0, 1, 2, 3, 4])
      expect(errorCode(await call(mira, { method: 'DELETE', url: `/playlists/${playlist.id}/items/${newId()}` }), 404)).toBe('playlist_item_not_found')
    })

    it('uses the covers of the first four distinct albums', async () => {
      const made: { album: Awaited<ReturnType<typeof createAlbum>>; cover: Awaited<ReturnType<typeof createAsset>> }[] = []
      for (let index = 0; index < 5; index++) {
        const album = await createAlbum({ tracks: [{ title: 'A' }, { title: 'B' }] })
        const cover = await createAsset()
        await db.update(albums).set({ artworkAssetId: cover.id }).where(eq(albums.id, album.albumId))
        made.push({ album, cover })
      }
      // An album without a cover is passed over.
      const bare = await createAlbum({ tracks: [{ title: 'Bare' }] })
      const playlist = await create(mira, { name: 'Covers' })
      const order = [0, 0, 1, 1, 2, 3, 4].map((index, position) => ({ trackId: made[index]!.album.tracks[position % 2]!.recordingId }))
      order.splice(1, 0, { trackId: bare.tracks[0]!.recordingId })
      const detail = body(await add(mira, playlist.id, { tracks: order }), PlaylistDetail)
      expect(detail.artworks.map((art) => art.id)).toEqual(made.slice(0, 4).map((entry) => entry.cover.id))
    })

    it('leaves out covers the art route cannot serve, taking the next album instead', async () => {
      const made: { album: Awaited<ReturnType<typeof createAlbum>>; cover: Awaited<ReturnType<typeof createAsset>> }[] = []
      for (let index = 0; index < 3; index++) {
        const album = await createAlbum({ tracks: [{ title: 'A' }] })
        const cover = await createAsset()
        await db.update(albums).set({ artworkAssetId: cover.id }).where(eq(albums.id, album.albumId))
        made.push({ album, cover })
      }
      await db.update(assets).set({ status: 'missing' }).where(eq(assets.id, made[0]!.cover.id))
      await db.update(assets).set({ status: 'failed', checkedAt: new Date() }).where(eq(assets.id, made[1]!.cover.id))
      const playlist = await create(mira, { name: 'Broken covers' })
      const detail = body(await add(mira, playlist.id, { tracks: made.map((entry) => ({ trackId: entry.album.tracks[0]!.recordingId })) }), PlaylistDetail)
      expect(detail.artworks.map((art) => art.id)).toEqual([made[2]!.cover.id])
    })

    it('keeps positions dense under concurrent adds, moves and removals', async () => {
      const album = await createAlbum({ tracks: Array.from({ length: 10 }, (_, index) => ({ title: `T${index}` })) })
      const playlist = await create(mira, { name: 'Busy' })
      const tracks = album.tracks.map((track) => track.recordingId)
      await Promise.all(tracks.map((trackId) => add(mira, playlist.id, { tracks: [{ trackId }, { trackId }] })))
      expect(await positions(playlist.id)).toEqual(Array.from({ length: 20 }, (_, index) => index))
      // Each request appended its two items together.
      const items = await db.select().from(playlistItems).where(eq(playlistItems.playlistId, playlist.id)).orderBy(asc(playlistItems.position))
      for (let index = 0; index < 20; index += 2) expect(items[index]!.recordingId).toBe(items[index + 1]!.recordingId)

      const results = await Promise.all([
        ...items.slice(0, 8).map((item, index) => call(mira, { method: 'POST', url: `/playlists/${playlist.id}/items/move`, payload: { itemId: item.id, toIndex: 19 - index } })),
        ...items.slice(10, 14).map((item) => call(mira, { method: 'DELETE', url: `/playlists/${playlist.id}/items/${item.id}` })),
        add(mira, playlist.id, { tracks: [{ trackId: tracks[0] }] }),
      ])
      expect(results.every((response) => response.statusCode === 200)).toBe(true)
      expect(await positions(playlist.id)).toEqual(Array.from({ length: 17 }, (_, index) => index))
    })
  })

  describe('history', () => {
    it('lists plays newest first, collapsing back-to-back repeats across pages', async () => {
      const listener = await signIn()
      const album = await createAlbum({ owned: true })
      const [a, b, c] = album.tracks.map((track) => track.recordingId)
      // Oldest first: a, a, b, a, c, c, c
      const sequence = [a, a, b, a, c, c, c]
      for (const [index, recordingId] of sequence.entries()) {
        await createPlay({ userId: listener.id, recordingId: recordingId!, albumId: album.albumId, minutesAgo: 100 - index })
      }
      const expected = [c, a, b, a]
      for (const limit of [1, 2, 50]) {
        const seen: string[] = []
        let cursor: string | null = null
        do {
          const page: HistoryPage = body(await call(listener, { url: `/me/history?limit=${limit}${cursor ? `&cursor=${cursor}` : ''}` }), HistoryPage)
          seen.push(...page.items.map((item) => item.track.id))
          cursor = page.nextCursor
        } while (cursor)
        expect(seen, `limit ${limit}`).toEqual(expected)
      }
      const [latest] = body(await call(listener, { url: '/me/history' }), HistoryPage).items
      expect(latest!.track.album?.id).toBe(album.albumId)
      expect(Date.parse(latest!.playedAt)).toBeGreaterThan(Date.now() - 95 * 60_000)
      expect(body(await call(mira, { url: '/me/history' }), HistoryPage).items).toEqual([])
    })
  })

  describe('wants', () => {
    const wantsOf = async (who: typeof mira, query = '') => body(await call(who, { url: `/me/wants${query}` }), WantPage)
    const describeItem = (item: WantPage['items'][number]) =>
      item.type === 'album' ? ['album', item.album.id, item.fulfilledAt !== null] : ['track', item.track.id, item.fulfilledAt !== null]

    beforeAll(async () => {
      await updateServerSettings({ wantlistEnabled: true })
    })

    it('reads as empty and refuses changes while switched off, keeping what is stored', async () => {
      const wanter = await signIn()
      const album = await createAlbum()
      const other = await createAlbum()
      body(await call(wanter, { method: 'PUT', url: `/me/wants/album/${album.albumId}` }), Ok)

      await updateServerSettings({ wantlistEnabled: false })
      try {
        expect(await wantsOf(wanter)).toEqual({ items: [], nextCursor: null })
        expect(body(await call(wanter, { url: `/albums/${album.albumId}` }), AlbumDetail).wanted).toBe(false)
        expect(errorCode(await call(wanter, { method: 'PUT', url: `/me/wants/album/${other.albumId}` }), 404)).toBe('wantlist_disabled')
        expect(errorCode(await call(wanter, { method: 'DELETE', url: `/me/wants/album/${album.albumId}` }), 404)).toBe('wantlist_disabled')
        // The import pipeline keeps refreshing wants either way.
        await refreshWants()
        expect(await db.select({ entityId: wants.entityId }).from(wants).where(eq(wants.userId, wanter.id))).toEqual([{ entityId: album.albumId }])
      } finally {
        await updateServerSettings({ wantlistEnabled: true })
      }
      expect((await wantsOf(wanter)).items.map(describeItem)).toEqual([['album', album.albumId, false]])
      expect(body(await call(wanter, { url: `/albums/${album.albumId}` }), AlbumDetail).wanted).toBe(true)
    })

    it('lists wants newest first and marks them fulfilled once imports cover them', async () => {
      const wanter = await signIn()
      const album = await createAlbum({ owned: [0] })
      const single = await createAlbum({ tracks: [{ title: 'Single' }] })
      const track = single.tracks[0]!.recordingId
      body(await call(wanter, { method: 'PUT', url: `/me/wants/album/${album.albumId}` }), Ok)
      body(await call(wanter, { method: 'PUT', url: `/me/wants/track/${track}` }), Ok)
      expect(invalidated).toHaveBeenCalledWith({ user: wanter.id }, [queryKeys.wants(), queryKeys.home(), queryKeys.track(track)])

      let list = await wantsOf(wanter)
      expect(list.items.map(describeItem)).toEqual([['track', track, false], ['album', album.albumId, false]])
      expect(list.items[1]).toMatchObject({ album: { availability: 'partial' }, fulfilledAt: null })
      expect(body(await call(wanter, { url: `/albums/${album.albumId}` }), AlbumDetail).wanted).toBe(true)
      // Pages walk the same list.
      const first = await wantsOf(wanter, '?limit=1')
      const second = await wantsOf(wanter, `?limit=1&cursor=${first.nextCursor}`)
      expect([...first.items, ...second.items].map(describeItem)).toEqual(list.items.map(describeItem))
      expect(second.nextCursor).toBeNull()

      // A partly owned album is not fulfilled; the import pipeline links the rest and refreshes everyone's wants.
      await refreshWants()
      expect((await wantsOf(wanter)).items.every((item) => item.fulfilledAt === null)).toBe(true)
      for (const missing of album.tracks.slice(1)) await createFile({ rootId: album.rootId!, recordingId: missing.recordingId, albumId: album.albumId })
      await createFile({ rootId: album.rootId!, recordingId: track })
      invalidated.mockClear()
      await refreshWants()
      expect(invalidated).toHaveBeenCalledWith({ user: wanter.id }, [queryKeys.wants(), queryKeys.home()])
      list = await wantsOf(wanter)
      expect(list.items.map(describeItem)).toEqual([['track', track, true], ['album', album.albumId, true]])
      expect(body(await call(wanter, { url: `/albums/${album.albumId}` }), AlbumDetail).wanted).toBe(false)
    })

    it('fulfils wants for owned music at once and removes wants', async () => {
      const wanter = await signIn()
      const owned = await createAlbum({ owned: true })
      const other = await createAlbum()
      body(await call(wanter, { method: 'PUT', url: `/me/wants/album/${owned.albumId}` }), Ok)
      body(await call(wanter, { method: 'PUT', url: `/me/wants/album/${other.albumId}` }), Ok)
      expect((await wantsOf(wanter)).items.map(describeItem)).toEqual([['album', other.albumId, false], ['album', owned.albumId, true]])
      body(await call(wanter, { method: 'DELETE', url: `/me/wants/album/${other.albumId}` }), Ok)
      expect((await wantsOf(wanter)).items.map(describeItem)).toEqual([['album', owned.albumId, true]])
      expect(await db.select().from(wants).where(and(eq(wants.userId, wanter.id), eq(wants.entityId, other.albumId)))).toEqual([])

      expect(errorCode(await call(wanter, { method: 'PUT', url: `/me/wants/artist/${owned.artist.id}` }), 400)).toBe('invalid_request')
      expect(errorCode(await call(wanter, { method: 'PUT', url: `/me/wants/album/${newId()}` }), 404)).toBe('album_not_found')
    })

    it('follows merges when wanting', async () => {
      const wanter = await signIn()
      const winner = await createAlbum({ tracks: [{ title: 'Kept' }] })
      const loser = await createAlbum({ tracks: [{ title: 'Gone' }] })
      await db.update(recordings).set({ mergedIntoId: winner.tracks[0]!.recordingId }).where(eq(recordings.id, loser.tracks[0]!.recordingId))
      body(await call(wanter, { method: 'PUT', url: `/me/wants/track/${loser.tracks[0]!.recordingId}` }), Ok)
      expect((await wantsOf(wanter)).items.map(describeItem)).toEqual([['track', winner.tracks[0]!.recordingId, false]])
    })
  })

  describe('settings', () => {
    it('applies defaults on read and merges partial updates, keeping unknown keys', async () => {
      const person = await signIn()
      expect(body(await call(person, { url: '/me/settings' }), UserSettings)).toEqual(UserSettings.parse({}))

      await db.update(users).set({ settings: { secrets: { lastFm: 'cipher' }, fromTheFuture: 1, qualityWifi: 'high' } }).where(eq(users.id, person.id))
      expect(body(await call(person, { url: '/me/settings' }), UserSettings).qualityWifi).toBe('high')

      const updated = body(await call(person, { method: 'PATCH', url: '/me/settings', payload: { normalization: 'album', downloadOnWifiOnly: false } }), UserSettings)
      expect(updated).toEqual({ ...UserSettings.parse({}), qualityWifi: 'high', normalization: 'album', downloadOnWifiOnly: false })
      expect(invalidated).toHaveBeenCalledWith({ user: person.id }, [queryKeys.settings()])
      const [row] = await db.select({ settings: users.settings }).from(users).where(eq(users.id, person.id))
      expect(row!.settings).toEqual({ secrets: { lastFm: 'cipher' }, fromTheFuture: 1, qualityWifi: 'high', normalization: 'album', downloadOnWifiOnly: false })

      expect(errorCode(await call(person, { method: 'PATCH', url: '/me/settings', payload: { normalization: 'loud' } }), 400)).toBe('invalid_request')
      // Unknown keys in a request are not stored.
      body(await call(person, { method: 'PATCH', url: '/me/settings', payload: { secrets: 'nope' } }), UserSettings)
      const [after] = await db.select({ settings: users.settings }).from(users).where(eq(users.id, person.id))
      expect((after!.settings as { secrets: unknown }).secrets).toEqual({ lastFm: 'cipher' })
    })

    it('refreshes the scrobbling status when a service is switched', async () => {
      const person = await signIn()
      invalidated.mockClear()
      body(await call(person, { method: 'PATCH', url: '/me/settings', payload: { scrobbleLastFm: true } }), UserSettings)
      // The status reports each service's switch, and other devices show it.
      expect(invalidated).toHaveBeenCalledWith({ user: person.id }, [queryKeys.settings(), queryKeys.scrobbling()])
    })
  })
})
