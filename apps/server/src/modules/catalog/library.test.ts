import { AlbumPage, ArtistPage, GenrePage, TrackPage } from '@squirmy/contracts'
import { asc, desc, eq, inArray, isNull } from 'drizzle-orm'
import type { FastifyInstance, LightMyRequestResponse } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { z } from 'zod'
import { buildApp } from '../../app.js'
import { db } from '../../database/client.js'
import { albums, mediaFiles } from '../../database/schema.js'
import { body, errorCode, signIn } from '../../test/api.js'
import { useTestDatabase } from '../../test/database.js'
import { createAlbum, createArtist } from '../../test/factories.js'

type AnyPage = z.ZodObject<{ items: z.ZodArray<z.ZodType>; nextCursor: z.ZodNullable<z.ZodString> }>

describe('library lists', () => {
  useTestDatabase()
  let app: FastifyInstance
  let headers: { authorization: string }

  /** Walks a list page by page; `between` runs after each page (to insert rows mid-walk). */
  async function walk<Schema extends AnyPage>(url: string, schema: Schema, limit: number, between?: (page: number) => Promise<void>) {
    const items: z.infer<Schema>['items'] = []
    let cursor: string | null = null
    for (let page = 0; page < 100; page++) {
      const separator = url.includes('?') ? '&' : '?'
      const response: LightMyRequestResponse = await app.inject({ url: `${url}${separator}limit=${limit}${cursor ? `&cursor=${cursor}` : ''}`, headers })
      const result: z.infer<AnyPage> = body(response, schema)
      expect(result.items.length).toBeLessThanOrEqual(limit)
      items.push(...result.items)
      cursor = result.nextCursor
      if (!cursor) return items
      await between?.(page)
    }
    throw new Error('Pagination did not end')
  }
  const ids = (items: { id: string }[]) => items.map((item) => item.id)

  let owned: Awaited<ReturnType<typeof createAlbum>>[] = []

  beforeAll(async () => {
    app = await buildApp()
    headers = (await signIn()).headers
    const zed = await createArtist({ name: 'Zed' })
    const theAbc = await createArtist({ name: 'The Abc' })
    const moss = await createArtist({ name: 'Moss' })
    owned = [
      await createAlbum({ artist: zed, title: 'Same', year: 2001, owned: true }),
      await createAlbum({ artist: theAbc, title: 'Same', year: 2001, owned: [0] }),
      await createAlbum({ artist: moss, title: 'The Beta', year: 1999, owned: true }),
      await createAlbum({ artist: moss, title: 'Alpha', owned: [2] }),
      await createAlbum({ artist: zed, title: 'Delta', year: 2010, owned: true }),
      await createAlbum({ artist: theAbc, title: 'Same', year: 2001, owned: true }),
    ]
    await createAlbum({ artist: moss, title: 'Not owned' })
    const gone = await createAlbum({ artist: moss, title: 'Gone', owned: true })
    await db.update(mediaFiles).set({ missingSince: new Date() }).where(eq(mediaFiles.albumId, gone.albumId))
    await db.update(albums).set({ year: null }).where(eq(albums.id, owned[3]!.albumId))
    await db.update(albums).set({ genres: ['Rock', 'Jazz'] }).where(eq(albums.id, owned[0]!.albumId))
    await db.update(albums).set({ genres: ['Rock'] }).where(inArray(albums.id, [owned[2]!.albumId, gone.albumId]))
    // Every file arrives in the same instant: recency ties go to the file path (track order), then the id.
    await db.update(mediaFiles).set({ addedAt: new Date('2026-01-01T00:00:00Z') })
  })
  afterAll(async () => {
    await app.close()
  })

  it('requires a signed-in user', async () => {
    expect(errorCode(await app.inject({ url: '/api/v1/library/albums' }), 401)).toBe('unauthorized')
  })

  it('lists owned albums in each order and pages through ties', async () => {
    const [zedSame, abcSame1, beta, alpha, delta, abcSame2] = owned.map((album) => album.albumId)
    const expected = {
      // Newest file first; the tie on added_at falls to file ids, i.e. creation order.
      recent: [abcSame2, delta, alpha, beta, abcSame1, zedSame],
      // "The Beta" sorts under B.
      title: [alpha, beta, delta, ...[zedSame, abcSame1, abcSame2].sort()],
      artist: [...[abcSame1, abcSame2].sort(), alpha, beta, delta, zedSame],
      year: [delta, ...[zedSame, abcSame1, abcSame2].sort(), beta, alpha],
    }
    for (const [sort, order] of Object.entries(expected)) {
      const whole = body(await app.inject({ url: `/api/v1/library/albums?sort=${sort}&limit=200`, headers }), AlbumPage)
      expect(ids(whole.items), sort).toEqual(order)
      expect(whole.nextCursor).toBeNull()
      for (const limit of [1, 2, 4]) {
        expect(ids(await walk(`/api/v1/library/albums?sort=${sort}`, AlbumPage, limit)), `${sort} by ${limit}`).toEqual(order)
      }
    }
    const first = body(await app.inject({ url: '/api/v1/library/albums?sort=title&limit=1', headers }), AlbumPage)
    expect(first.items[0]).toMatchObject({ title: 'Alpha', availability: 'partial', ownedTrackCount: 1, trackCount: 3 })
  })

  it('keeps every existing album exactly once while albums are added mid-walk', async () => {
    const before = ids(body(await app.inject({ url: '/api/v1/library/albums?sort=title&limit=200', headers }), AlbumPage).items)
    const added: string[] = []
    const seen = ids(await walk('/api/v1/library/albums?sort=title', AlbumPage, 2, async (page) => {
      // One sorts before the cursor, one after it.
      added.push((await createAlbum({ title: `Aardvark ${page}`, owned: true })).albumId)
      added.push((await createAlbum({ title: `Zulu ${page}`, owned: true })).albumId)
    }))
    expect(new Set(seen).size).toBe(seen.length)
    expect(seen.filter((id) => before.includes(id))).toEqual(before)
    expect(seen.filter((id) => !before.includes(id)).every((id) => added.includes(id))).toBe(true)
    await db.update(mediaFiles).set({ missingSince: new Date() }).where(inArray(mediaFiles.albumId, added))
  })

  it('pages by recency while files keep arriving', async () => {
    const before = ids(body(await app.inject({ url: '/api/v1/library/albums?limit=200', headers }), AlbumPage).items)
    const added: string[] = []
    // New albums are the newest, so they land before the cursor and the walk goes on undisturbed.
    const seen = ids(await walk('/api/v1/library/albums', AlbumPage, 2, async () => {
      added.push((await createAlbum({ owned: true })).albumId)
    }))
    expect(seen).toEqual(before)
    const now = ids(body(await app.inject({ url: `/api/v1/library/albums?limit=${added.length}`, headers }), AlbumPage).items)
    expect(now).toEqual([...added].reverse())
    await db.update(mediaFiles).set({ missingSince: new Date() }).where(inArray(mediaFiles.albumId, added))
  })

  it('filters albums by genre and lists genres with counts', async () => {
    const rock = body(await app.inject({ url: '/api/v1/library/albums?genre=rock&sort=title', headers }), AlbumPage)
    expect(ids(rock.items)).toEqual([owned[2]!.albumId, owned[0]!.albumId])
    const recentRock = body(await app.inject({ url: '/api/v1/library/albums?genre=Rock', headers }), AlbumPage)
    expect(ids(recentRock.items)).toEqual([owned[2]!.albumId, owned[0]!.albumId])
    // The album whose files are all missing does not count; spellings differing in case count together.
    expect(await walk('/api/v1/library/genres', GenrePage, 1)).toEqual([{ name: 'Jazz', albumCount: 1 }, { name: 'Rock', albumCount: 2 }])
    await db.update(albums).set({ genres: ['rock', 'ROCK'] }).where(eq(albums.id, owned[4]!.albumId))
    expect(await walk('/api/v1/library/genres', GenrePage, 1)).toEqual([{ name: 'Jazz', albumCount: 1 }, { name: 'Rock', albumCount: 3 }])
    await db.update(albums).set({ genres: [] }).where(eq(albums.id, owned[4]!.albumId))

    // A track has the genres of its file's album.
    const jazzIds = owned[0]!.tracks.map((track) => track.recordingId)
    for (const sort of ['recent', 'title', 'artist']) {
      const jazz = await walk(`/api/v1/library/tracks?genre=JAZZ&sort=${sort}`, TrackPage, 2)
      expect(ids(jazz).sort(), sort).toEqual([...jazzIds].sort())
    }
  })

  it('lists album artists of owned albums by sort name', async () => {
    // Artists have one order; `sort` and `genre` do not apply.
    expect(await walk('/api/v1/library/artists?sort=year&genre=Jazz', ArtistPage, 1)).toEqual(await walk('/api/v1/library/artists', ArtistPage, 1))
    const artists = await walk('/api/v1/library/artists', ArtistPage, 1)
    expect(artists.map((artist) => artist.name)).toEqual(['The Abc', 'Moss', 'Zed'])
    expect(artists.every((artist) => artist.inLibrary)).toBe(true)
  })

  it('lists owned tracks in each order', async () => {
    const all = owned.flatMap((album) => album.tracks.filter((track) => track.fileId).map((track) => ({ ...track, albumId: album.albumId })))
    for (const sort of ['recent', 'title', 'artist', 'year']) {
      const tracks = await walk(`/api/v1/library/tracks?sort=${sort}`, TrackPage, 3)
      expect(tracks.length, sort).toBe(all.length)
      expect(new Set(ids(tracks)).size).toBe(all.length)
      expect(tracks.every((track) => track.availability === 'server')).toBe(true)
    }
    const recent = await walk('/api/v1/library/tracks', TrackPage, 5)
    // Songs that arrived together come in track order (by path), not in reverse id order.
    const byPath = await db.select({ id: mediaFiles.recordingId, albumId: mediaFiles.albumId }).from(mediaFiles)
      .where(isNull(mediaFiles.missingSince)).orderBy(asc(mediaFiles.relPath), desc(mediaFiles.recordingId))
    expect(ids(recent)).toEqual(byPath.map((file) => file.id))
    expect(recent[0]!.album?.id).toBe(byPath[0]!.albumId)

    const byTitle = await walk('/api/v1/library/tracks?sort=title', TrackPage, 4)
    const titles = byTitle.map((track) => track.title)
    expect(titles).toEqual([...titles].sort())
    const byArtist = await walk('/api/v1/library/tracks?sort=artist', TrackPage, 4)
    expect(byArtist[0]!.artistCredit).toBe('The Abc')
    expect(byArtist.at(-1)!.artistCredit).toBe('Zed')

    // By year: albums newest first as in the album list, each album's tracks in order.
    const [zedSame, abcSame1, beta, alpha, delta, abcSame2] = owned
    const albumOrder = [delta!, ...[zedSame!, abcSame1!, abcSame2!].sort((a, b) => (a.albumId < b.albumId ? -1 : 1)), beta!, alpha!]
    const byYear = await walk('/api/v1/library/tracks?sort=year', TrackPage, 2)
    expect(byYear.map((track) => [track.id, track.album?.id])).toEqual(albumOrder.flatMap((album) =>
      album.tracks.filter((track) => track.fileId).map((track) => [track.recordingId, album.albumId])))
    expect(await walk('/api/v1/library/tracks?sort=year&genre=rock', TrackPage, 2)).toEqual(byYear.filter((track) => [zedSame!.albumId, beta!.albumId].includes(track.album!.id)))
  })

  it('rejects cursors that are malformed or belong to another list', async () => {
    const page = body(await app.inject({ url: '/api/v1/library/albums?sort=title&limit=1', headers }), AlbumPage)
    expect(errorCode(await app.inject({ url: `/api/v1/library/albums?sort=recent&cursor=${page.nextCursor}`, headers }), 400)).toBe('invalid_cursor')
    expect(errorCode(await app.inject({ url: '/api/v1/library/albums?cursor=nonsense', headers }), 400)).toBe('invalid_cursor')
    const forged = Buffer.from(JSON.stringify({ o: 'albums:recent', k: ["'; drop table albums; --", 'x'] })).toString('base64url')
    expect(errorCode(await app.inject({ url: `/api/v1/library/albums?cursor=${forged}`, headers }), 400)).toBe('invalid_cursor')
    expect(errorCode(await app.inject({ url: '/api/v1/library/albums?sort=newest', headers }), 400)).toBe('invalid_request')
  })
})
