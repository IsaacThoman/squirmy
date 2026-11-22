import { AlbumDetail, HomeResponse, PlaylistDetail, PlaylistPage, queryKeys } from '@squirmy/contracts'
import { eq } from 'drizzle-orm'
import Fastify, { type FastifyInstance } from 'fastify'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { buildApp } from '../app.js'
import { resetConfig } from '../config.js'
import { db, getSql } from '../database/client.js'
import { albums } from '../database/schema.js'
import { announce } from '../modules/matching/match.js'
import { mergeAlbum } from '../modules/matching/merge.js'
import { flushInvalidations, invalidateSoon } from '../modules/library/progress.js'
import { startRealtime } from '../realtime/index.js'
import { body, signIn } from '../test/api.js'
import { createFile } from '../test/catalog.js'
import { useTestDatabase } from '../test/database.js'
import { createAlbum, createLibraryRoot } from '../test/factories.js'
import { cachedRead, clearReadCache, dropCachedReads, readCacheStats } from './read-cache.js'

describe('read cache', () => {
  useTestDatabase()
  let app: FastifyInstance
  let user: Awaited<ReturnType<typeof signIn>>

  beforeAll(async () => {
    process.env.SQUIRMY_READ_CACHE_MB = '16'
    resetConfig()
    app = await buildApp()
    await startRealtime(app)
    user = await signIn()
  })
  afterAll(async () => {
    await app.close()
    delete process.env.SQUIRMY_READ_CACHE_MB
    resetConfig()
  })
  beforeEach(() => clearReadCache())

  const get = (url: string, as = user) => app.inject({ url: `/api/v1${url}`, headers: as.headers })
  const call = (method: 'PUT' | 'DELETE' | 'POST' | 'PATCH', url: string, payload?: object) =>
    app.inject({ method, url: `/api/v1${url}`, headers: user.headers, payload })
  const rename = (albumId: string, title: string) => db.update(albums).set({ title }).where(eq(albums.id, albumId))
  /** Waits for the NOTIFY round trip, which drops the API process's entries a second time. */
  const settled = () => new Promise((resolve) => setTimeout(resolve, 100))

  it('serves a repeated read from memory until a like invalidates it', async () => {
    const album = await createAlbum({ title: 'Kept', owned: true })
    const first = body(await get(`/albums/${album.albumId}`), AlbumDetail)
    expect(first.liked).toBe(false)
    // A change nothing announces is not seen: the answer came from the cache.
    await rename(album.albumId, 'Renamed quietly')
    const cached = await get(`/albums/${album.albumId}`)
    expect(body(cached, AlbumDetail).title).toBe('Kept')
    expect(cached.headers.etag).toBeDefined()
    expect((await app.inject({ url: `/api/v1/albums/${album.albumId}`, headers: { ...user.headers, 'if-none-match': cached.headers.etag } })).statusCode).toBe(304)

    expect((await call('PUT', `/me/likes/track/${album.tracks[0]!.recordingId}`)).statusCode).toBe(200)
    const after = body(await get(`/albums/${album.albumId}`), AlbumDetail)
    expect(after.title).toBe('Renamed quietly')
    expect(after.discs[0]!.tracks[0]!.liked).toBe(true)
    const home = body(await get('/home'), HomeResponse)
    expect((await call('PUT', `/me/likes/album/${album.albumId}`)).statusCode).toBe(200)
    const liked = body(await get('/home'), HomeResponse)
    expect(home.sections.some((section) => section.id === 'liked-albums')).toBe(false)
    expect(liked.sections.find((section) => section.id === 'liked-albums')).toBeDefined()
  })

  it('keeps users apart: one user’s like leaves the other’s cache alone', async () => {
    const other = await signIn()
    const album = await createAlbum({ title: 'Shared', owned: true })
    await get(`/albums/${album.albumId}`, other)
    await rename(album.albumId, 'Changed')
    await call('PUT', `/me/likes/album/${album.albumId}`)
    expect(body(await get(`/albums/${album.albumId}`, other), AlbumDetail).title).toBe('Shared')
    expect(body(await get(`/albums/${album.albumId}`), AlbumDetail).title).toBe('Changed')
  })

  it('drops lists when a scan adds music, through the coalesced invalidation', async () => {
    const root = await createLibraryRoot()
    await createAlbum({ title: 'Already here', owned: true, rootId: root.id })
    const ids = async () => ((await get('/library/albums?sort=title')).json().items as { id: string }[]).map((item) => item.id)
    const before = await ids()
    const added = await createAlbum({ title: 'Arrived', tracks: [{ title: 'New' }] })
    await createFile({ rootId: root.id, recordingId: added.tracks[0]!.recordingId, albumId: added.albumId })
    expect(await ids()).toEqual(before)
    invalidateSoon([queryKeys.library(), queryKeys.home(), queryKeys.album(added.albumId)])
    await flushInvalidations()
    expect(await ids()).toContain(added.albumId)
  })

  it('drops playlist reads when the playlist is edited', async () => {
    const album = await createAlbum({ title: 'Mix source', owned: true })
    const playlist = (await call('POST', '/playlists', { name: 'Mix' })).json() as { id: string }
    expect(body(await get(`/playlists/${playlist.id}`), PlaylistDetail).items).toHaveLength(0)
    expect(body(await get('/playlists'), PlaylistPage).items[0]!.trackCount).toBe(0)
    await call('POST', `/playlists/${playlist.id}/items`, { tracks: [{ trackId: album.tracks[0]!.recordingId }] })
    expect(body(await get(`/playlists/${playlist.id}`), PlaylistDetail).items).toHaveLength(1)
    expect(body(await get('/playlists'), PlaylistPage).items[0]!.trackCount).toBe(1)
    await call('PATCH', `/playlists/${playlist.id}`, { name: 'Renamed mix' })
    expect(body(await get(`/playlists/${playlist.id}`), PlaylistDetail).name).toBe('Renamed mix')
  })

  it('follows a merge once matching announces it', async () => {
    const loser = await createAlbum({ title: 'Local copy', owned: true })
    const winner = await createAlbum({ title: 'Canonical', tracks: loser.tracks.map(() => ({ title: 'x' })) })
    expect(body(await get(`/albums/${loser.albumId}`), AlbumDetail).id).toBe(loser.albumId)
    await mergeAlbum(loser.albumId, winner.albumId)
    expect(body(await get(`/albums/${loser.albumId}`), AlbumDetail).id).toBe(loser.albumId)
    await announce([winner.albumId, loser.albumId], [])
    expect(body(await get(`/albums/${loser.albumId}`), AlbumDetail).id).toBe(winner.albumId)
  })

  it('drops entries when another process announces a change over NOTIFY', async () => {
    const album = await createAlbum({ title: 'From the worker', owned: true })
    await get(`/albums/${album.albumId}`)
    await rename(album.albumId, 'Enriched')
    // What `invalidate` in a worker process sends; nothing in this process is told directly.
    await getSql()`select pg_notify('squirmy_events', ${JSON.stringify({ kind: 'invalidate', target: 'all', keys: [queryKeys.album(album.albumId)] })})`
    await settled()
    expect(body(await get(`/albums/${album.albumId}`), AlbumDetail).title).toBe('Enriched')
  })

  it('ignores invalidations that change nothing it holds', async () => {
    const album = await createAlbum({ title: 'Steady', owned: true })
    await get(`/albums/${album.albumId}`)
    await call('PATCH', '/me/settings', { qualityWifi: 'high' })
    dropCachedReads('admins', [queryKeys.adminJobs()])
    expect(readCacheStats().entries).toBe(1)
  })

  it('does not keep a result computed across an invalidation, and shares one computation', async () => {
    const small = Fastify()
    let value = 'old'
    let computed = 0
    let release: () => void = () => {}
    small.get('/api/v1/thing', (request, reply) => cachedRead(request, reply, { userId: 'u', tags: ['album'] }, async () => {
      computed++
      const seen = value
      await new Promise<void>((resolve) => { release = resolve })
      return { value: seen }
    }))
    const first = small.inject({ url: '/api/v1/thing' })
    const second = small.inject({ url: '/api/v1/thing' })
    await new Promise((resolve) => setTimeout(resolve, 20))
    value = 'new'
    dropCachedReads('all', [queryKeys.album('x')])
    release()
    expect((await first).json()).toEqual({ value: 'old' })
    expect((await second).json()).toEqual({ value: 'old' })
    expect(computed).toBe(1)
    const third = small.inject({ url: '/api/v1/thing' })
    await new Promise((resolve) => setTimeout(resolve, 20))
    release()
    expect((await third).json()).toEqual({ value: 'new' })
    await small.close()
  })
})
