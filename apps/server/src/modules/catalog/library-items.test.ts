import { LibraryItemPage, type LibraryItem, type LibraryItemsSort } from '@squirmy/contracts'
import { eq, sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from '../../app.js'
import { db } from '../../database/client.js'
import { albums, collectionPlays, likes, mediaFiles, playlists } from '../../database/schema.js'
import { newId } from '../../lib/ids.js'
import { body, errorCode, signIn } from '../../test/api.js'
import { useTestDatabase } from '../../test/database.js'
import { createAlbum, createArtist, createUser } from '../../test/factories.js'
import { mergeAlbum } from '../matching/merge.js'
import { LIKED_SONGS_ID } from './library-items.js'

const day = (n: number) => new Date(Date.UTC(2026, 0, n))

describe('the Library\'s All', () => {
  useTestDatabase()
  let app: FastifyInstance
  let user: Awaited<ReturnType<typeof signIn>>
  /** Names of the items, keyed by id: what the expectations are written in. */
  const names = new Map<string, string>()

  const label = (item: LibraryItem) => {
    switch (item.kind) {
      case 'liked': return 'Liked Songs'
      case 'album': return names.get(item.album.id)!
      case 'artist': return names.get(item.artist.id)!
      case 'playlist': return names.get(item.playlist.id)!
    }
  }

  async function page(query: string): Promise<LibraryItemPage> {
    return body(await app.inject({ url: `/api/v1/library/items${query}`, headers: user.headers }), LibraryItemPage)
  }

  /** Walks the whole list `limit` at a time and names what it holds, in order. */
  async function walk(query: string, limit: number): Promise<string[]> {
    const shown: string[] = []
    let cursor: string | null = null
    for (let index = 0; index < 50; index++) {
      const separator = query ? '&' : '?'
      const result: LibraryItemPage = await page(`${query}${separator}limit=${limit}${cursor ? `&cursor=${cursor}` : ''}`)
      expect(result.items.length).toBeLessThanOrEqual(limit)
      shown.push(...result.items.map(label))
      cursor = result.nextCursor
      if (!cursor) return shown
    }
    throw new Error('Pagination did not end')
  }

  const played = (type: 'album' | 'artist' | 'playlist' | 'liked', entityId: string, playedAt: Date) =>
    db.insert(collectionPlays).values({ userId: user.id, entityType: type, entityId, playedAt })
      .onConflictDoUpdate({ target: [collectionPlays.userId, collectionPlays.entityType, collectionPlays.entityId], set: { playedAt } })

  let bright: Awaited<ReturnType<typeof createAlbum>>
  let quiet: Awaited<ReturnType<typeof createAlbum>>
  let roadTrip: string
  let zed: { id: string; name: string }

  beforeAll(async () => {
    app = await buildApp()
    user = await signIn({ username: 'listener' })
    const other = await createUser({ username: 'other' })
    const moss = await createArtist({ name: 'Moss' })
    zed = await createArtist({ name: 'Zed' })
    const lone = await createArtist({ name: 'Lone' })
    const ghost = await createArtist({ name: 'Ghost' })
    bright = await createAlbum({ artist: moss, title: 'Bright', year: 2001, owned: true })
    quiet = await createAlbum({ artist: zed, title: 'Quiet', year: 2010 })
    const notMine = await createAlbum({ artist: ghost, title: 'Not mine' })
    for (const [id, name] of [[moss.id, 'Moss'], [zed.id, 'Zed'], [lone.id, 'Lone'], [bright.albumId, 'Bright'], [quiet.albumId, 'Quiet']] as const) names.set(id, name)

    // Bright's files arrive on day 1; it is the collection's, so Moss is in the library then too.
    await db.update(mediaFiles).set({ addedAt: day(1) }).where(eq(mediaFiles.albumId, bright.albumId))
    await db.update(albums).set({ genres: ['Rock'] }).where(eq(albums.id, bright.albumId))
    roadTrip = newId()
    const evening = newId()
    const hidden = newId()
    names.set(roadTrip, 'Road Trip').set(evening, 'Evening')
    await db.insert(playlists).values([
      { id: roadTrip, ownerId: user.id, name: 'Road Trip', createdAt: day(2) },
      { id: evening, ownerId: other.id, name: 'Evening', isPublic: true, createdAt: day(5) },
      // Someone else's private playlist is never listed, played or not.
      { id: hidden, ownerId: other.id, name: 'Hidden', createdAt: day(8) },
    ])
    await db.insert(likes).values([
      // A saved album without files: Quiet, and Zed with it.
      { userId: user.id, entityType: 'album', entityId: quiet.albumId, createdAt: day(3) },
      { userId: user.id, entityType: 'artist', entityId: lone.id, createdAt: day(4) },
      { userId: user.id, entityType: 'recording', entityId: bright.tracks[0]!.recordingId, createdAt: day(6) },
      // Saving Moss later than its album came places it then.
      { userId: user.id, entityType: 'artist', entityId: moss.id, createdAt: day(7) },
    ])
    // Plays of what is not in the library leave it out.
    await played('playlist', hidden, day(40))
    await played('album', notMine.albumId, day(41))
  })
  afterAll(async () => {
    await app.close()
  })

  it('requires a signed-in user and a cursor of its own order', async () => {
    expect(errorCode(await app.inject({ url: '/api/v1/library/items' }), 401)).toBe('unauthorized')
    const { nextCursor } = await page('?sort=title&limit=1')
    expect(errorCode(await app.inject({ url: `/api/v1/library/items?sort=recent&cursor=${nextCursor}`, headers: user.headers }), 400)).toBe('invalid_cursor')
  })

  it('lists albums, artists, playlists and Liked Songs together in every order, page by page', async () => {
    const expected: Record<Exclude<LibraryItemsSort, 'played'>, string[]> = {
      // When each entered the library; Quiet and Zed tie on day 3 and go by id, newest first.
      recent: ['Moss', 'Liked Songs', 'Evening', 'Lone', 'Quiet', 'Zed', 'Road Trip', 'Bright'],
      title: ['Bright', 'Evening', 'Liked Songs', 'Lone', 'Moss', 'Quiet', 'Road Trip', 'Zed'],
      // By creator: Liked Songs and Road Trip are the listener's, an artist leads its own albums.
      artist: ['Liked Songs', 'Road Trip', 'Lone', 'Moss', 'Bright', 'Evening', 'Zed', 'Quiet'],
      // Only albums have a year; the rest follow by title.
      year: ['Quiet', 'Bright', 'Evening', 'Liked Songs', 'Lone', 'Moss', 'Road Trip', 'Zed'],
    }
    for (const [sort, names] of Object.entries(expected)) {
      for (const limit of [1, 2, 3, 50]) expect(await walk(`?sort=${sort}`, limit), `${sort} by ${limit}`).toEqual(names)
    }
  })

  it('puts what was played first, most recent first, then the rest by when it was added', async () => {
    // Nothing played yet: the recently added order.
    expect(await walk('', 50)).toEqual(['Moss', 'Liked Songs', 'Evening', 'Lone', 'Quiet', 'Zed', 'Road Trip', 'Bright'])

    await played('artist', zed.id, day(32))
    await played('album', bright.albumId, day(33))
    await played('playlist', roadTrip, day(34))
    const order = ['Road Trip', 'Bright', 'Zed', 'Moss', 'Liked Songs', 'Evening', 'Lone', 'Quiet']
    for (const limit of [1, 2, 3, 4, 50]) expect(await walk('', limit), `by ${limit}`).toEqual(order)
    expect(await walk('?sort=played', 2)).toEqual(order)

    const first = await page('?limit=4')
    expect(first.items.map((item) => item.playedAt)).toEqual([day(34).toISOString(), day(33).toISOString(), day(32).toISOString(), null])
    expect(first.items[1]).toMatchObject({ kind: 'album', album: { id: bright.albumId, title: 'Bright' } })
    expect(first.items[2]).toMatchObject({ kind: 'artist', artist: { id: zed.id, name: 'Zed', inLibrary: true } })

    // Playing Liked Songs again moves it to the front.
    await played('liked', LIKED_SONGS_ID, day(35))
    expect((await walk('', 3)).slice(0, 2)).toEqual(['Liked Songs', 'Road Trip'])
    expect((await page('?limit=1')).items).toEqual([{ kind: 'liked', playedAt: day(35).toISOString() }])
  })

  it('keeps a genre to its albums', async () => {
    expect(await walk('?genre=rock', 1)).toEqual(['Bright'])
    expect(await walk('?sort=title&genre=Rock', 1)).toEqual(['Bright'])
    expect(await walk('?sort=recent&genre=Jazz', 1)).toEqual([])
  })

  it('keeps an album\'s plays through a merge, the later one winning', async () => {
    const twin = await createAlbum({ artist: zed, title: 'Quiet (twin)' })
    await db.insert(likes).values({ userId: user.id, entityType: 'album', entityId: twin.albumId, createdAt: day(9) })
    await played('album', twin.albumId, day(60))
    await played('album', quiet.albumId, day(50))
    await mergeAlbum(twin.albumId, quiet.albumId)
    const rows = await db.select().from(collectionPlays).where(sql`${collectionPlays.userId} = ${user.id} and ${collectionPlays.entityType} = 'album'`)
    expect(rows.filter((row) => row.entityId === twin.albumId)).toEqual([])
    expect(rows.find((row) => row.entityId === quiet.albumId)?.playedAt).toEqual(day(60))
    expect((await walk('', 1))[0]).toBe('Quiet')
  })
})
