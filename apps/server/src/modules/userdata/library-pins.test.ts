import { LIBRARY_PIN_LIMIT, LIKED_SONGS_ID, LibraryItemPage, type LibraryItem, type LibraryItemsSort } from '@squirmy/contracts'
import { eq, sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from '../../app.js'
import { db } from '../../database/client.js'
import { albums, libraryPins, likes, mediaFiles, playlists } from '../../database/schema.js'
import { newId } from '../../lib/ids.js'
import { body, errorCode, signIn } from '../../test/api.js'
import { useTestDatabase } from '../../test/database.js'
import { createAlbum, createArtist, createUser } from '../../test/factories.js'
import { mergeAlbum } from '../matching/merge.js'

const day = (n: number) => new Date(Date.UTC(2026, 0, n))

describe('pins of the Library', () => {
  useTestDatabase()
  let app: FastifyInstance
  let user: Awaited<ReturnType<typeof signIn>>
  /** Names of the items, keyed by id: what the expectations are written in. */
  const names = new Map<string, string>()
  let bright: Awaited<ReturnType<typeof createAlbum>>
  let quiet: Awaited<ReturnType<typeof createAlbum>>
  let moss: Awaited<ReturnType<typeof createArtist>>
  let roadTrip: string
  let hidden: string

  const label = (item: LibraryItem) => {
    const name = item.kind === 'liked' ? 'Liked Songs'
      : names.get(item.kind === 'album' ? item.album.id : item.kind === 'artist' ? item.artist.id : item.playlist.id)!
    return item.pinned ? `📌 ${name}` : name
  }

  const pin = (kind: string, id: string, method: 'PUT' | 'DELETE' = 'PUT', headers: Record<string, string> = user.headers) =>
    app.inject({ method, url: `/api/v1/me/pins/${kind}/${id}`, headers })

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
      // Only the first page has pins, on top of its `limit`.
      expect(result.items.filter((item) => !item.pinned).length).toBeLessThanOrEqual(limit)
      if (cursor) expect(result.items.some((item) => item.pinned)).toBe(false)
      shown.push(...result.items.map(label))
      cursor = result.nextCursor
      if (!cursor) return shown
    }
    throw new Error('Pagination did not end')
  }

  beforeAll(async () => {
    app = await buildApp()
    user = await signIn({ username: 'listener', settings: { libraryIncludesServerMusic: true } })
    const other = await createUser({ username: 'other' })
    moss = await createArtist({ name: 'Moss' })
    const zed = await createArtist({ name: 'Zed' })
    bright = await createAlbum({ artist: moss, title: 'Bright', year: 2001, owned: true })
    quiet = await createAlbum({ artist: zed, title: 'Quiet', year: 2010 })
    await db.update(mediaFiles).set({ addedAt: day(1) }).where(eq(mediaFiles.albumId, bright.albumId))
    await db.update(albums).set({ genres: ['Rock'] }).where(eq(albums.id, bright.albumId))
    roadTrip = newId()
    hidden = newId()
    for (const [id, name] of [[moss.id, 'Moss'], [zed.id, 'Zed'], [bright.albumId, 'Bright'], [quiet.albumId, 'Quiet'], [roadTrip, 'Road Trip']] as const) {
      names.set(id, name)
    }
    await db.insert(playlists).values([
      { id: roadTrip, ownerId: user.id, name: 'Road Trip', createdAt: day(2) },
      { id: hidden, ownerId: other.id, name: 'Hidden', createdAt: day(8) },
    ])
    await db.insert(likes).values([
      { userId: user.id, entityType: 'album', entityId: quiet.albumId, createdAt: day(3) },
      { userId: user.id, entityType: 'recording', entityId: bright.tracks[0]!.recordingId, createdAt: day(6) },
    ])
  })
  afterAll(async () => {
    await app.close()
  })

  it('requires a signed-in user, a kind it knows and something that exists', async () => {
    expect(errorCode(await pin('album', bright.albumId, 'PUT', {}), 401)).toBe('unauthorized')
    expect((await pin('track', bright.albumId)).statusCode).toBe(400)
    expect(errorCode(await pin('album', newId()), 404)).toBe('album_not_found')
    expect(errorCode(await pin('artist', newId()), 404)).toBe('artist_not_found')
    // Someone else's private playlist is not there for this user.
    expect(errorCode(await pin('playlist', hidden), 404)).toBe('playlist_not_found')
    expect(errorCode(await pin('liked', newId()), 404)).toBe('liked_not_found')
  })

  it('puts the pins first in every order, most recently pinned first, and leaves them out of the rest', async () => {
    const unpinned: Record<LibraryItemsSort, string[]> = {
      played: ['Liked Songs', 'Quiet', 'Zed', 'Road Trip', 'Bright', 'Moss'],
      recent: ['Liked Songs', 'Quiet', 'Zed', 'Road Trip', 'Bright', 'Moss'],
      title: ['Bright', 'Liked Songs', 'Moss', 'Quiet', 'Road Trip', 'Zed'],
      artist: ['Liked Songs', 'Road Trip', 'Moss', 'Bright', 'Zed', 'Quiet'],
      year: ['Quiet', 'Bright', 'Liked Songs', 'Moss', 'Road Trip', 'Zed'],
    }
    for (const [sort, order] of Object.entries(unpinned)) expect(await walk(`?sort=${sort}`, 50), sort).toEqual(order)

    expect((await pin('album', bright.albumId)).statusCode).toBe(200)
    expect((await pin('playlist', roadTrip)).statusCode).toBe(200)
    expect((await pin('liked', LIKED_SONGS_ID)).statusCode).toBe(200)
    // Pinning again keeps the pin's place.
    expect((await pin('album', bright.albumId)).statusCode).toBe(200)
    const pinned = ['📌 Liked Songs', '📌 Road Trip', '📌 Bright']
    for (const [sort, order] of Object.entries(unpinned)) {
      const rest = order.filter((name) => !['Liked Songs', 'Road Trip', 'Bright'].includes(name))
      for (const limit of [1, 2, 50]) expect(await walk(`?sort=${sort}`, limit), `${sort} by ${limit}`).toEqual([...pinned, ...rest])
    }
    // The first page holds its `limit` beside the pins.
    expect((await page('?limit=2')).items.map(label)).toEqual([...pinned, 'Quiet', 'Zed'])
    expect((await page('?limit=2')).items[0]).toEqual({ kind: 'liked', playedAt: null, pinned: true })

    expect((await pin('playlist', roadTrip, 'DELETE')).statusCode).toBe(200)
    expect((await pin('playlist', roadTrip, 'DELETE')).statusCode).toBe(200)
    expect(await walk('?sort=title', 1)).toEqual(['📌 Liked Songs', '📌 Bright', 'Moss', 'Quiet', 'Road Trip', 'Zed'])
  })

  it('keeps a genre to its pinned albums', async () => {
    expect(await walk('?genre=rock', 1)).toEqual(['📌 Bright'])
    expect(await walk('?genre=jazz', 1)).toEqual([])
  })

  it('shows a pin only while its item is in the library, and drops it at the next pin', async () => {
    expect((await pin('album', quiet.albumId)).statusCode).toBe(200)
    expect((await walk('', 50)).slice(0, 3)).toEqual(['📌 Quiet', '📌 Liked Songs', '📌 Bright'])
    await db.delete(likes).where(sql`${likes.userId} = ${user.id} and ${likes.entityId} = ${quiet.albumId}`)
    expect(await walk('', 50)).toEqual(['📌 Liked Songs', '📌 Bright', 'Road Trip', 'Moss'])

    expect((await pin('artist', moss.id)).statusCode).toBe(200)
    const rows = await db.select().from(libraryPins).where(eq(libraryPins.userId, user.id))
    expect(rows.map((row) => row.entityId).sort()).toEqual([LIKED_SONGS_ID, bright.albumId, moss.id].sort())
  })

  it('follows an album through a merge', async () => {
    const twin = await createAlbum({ artist: moss, title: 'Bright (twin)', owned: true })
    await mergeAlbum(bright.albumId, twin.albumId)
    names.set(twin.albumId, 'Bright')
    const rows = await db.select().from(libraryPins).where(sql`${libraryPins.userId} = ${user.id} and ${libraryPins.entityType} = 'album'`)
    expect(rows.map((row) => row.entityId)).toEqual([twin.albumId])
    // Unpinning by the old id finds it too.
    expect((await pin('album', bright.albumId, 'DELETE')).statusCode).toBe(200)
    expect(await db.$count(libraryPins, sql`${libraryPins.userId} = ${user.id} and ${libraryPins.entityType} = 'album'`)).toBe(0)
  })

  it(`pins at most ${LIBRARY_PIN_LIMIT} items`, async () => {
    const owned = Array.from({ length: LIBRARY_PIN_LIMIT }, (_, index) => ({ id: newId(), ownerId: user.id, name: `List ${index}` }))
    await db.insert(playlists).values(owned)
    await db.delete(libraryPins).where(eq(libraryPins.userId, user.id))
    await db.insert(libraryPins).values(owned.map((playlist) => ({ userId: user.id, entityType: 'playlist' as const, entityId: playlist.id })))
    expect(errorCode(await pin('liked', LIKED_SONGS_ID), 409)).toBe('too_many_pins')
    // A pin already there is no new one.
    expect((await pin('playlist', owned[0]!.id)).statusCode).toBe(200)
    // A deleted playlist's pin no longer counts.
    await db.delete(playlists).where(eq(playlists.id, owned[1]!.id))
    expect((await pin('liked', LIKED_SONGS_ID)).statusCode).toBe(200)
  })
})
