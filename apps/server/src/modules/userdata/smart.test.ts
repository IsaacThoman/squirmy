import {
  ApiErrorBody, Ok, PLAYLIST_ITEM_LIMIT, PlaylistDetail, PlaylistPage, PlaylistSummary, queryKeys, SmartPlaylistPreview, SmartPlaylistRules,
  type SmartCondition, type SmartRule,
} from '@squirmy/contracts'
import { eq, sql } from 'drizzle-orm'
import { PgDialect } from 'drizzle-orm/pg-core'
import type { FastifyInstance, InjectOptions } from 'fastify'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildApp } from '../../app.js'
import { db } from '../../database/client.js'
import { albums, likes, mediaFiles, playlists, ratings } from '../../database/schema.js'
import { invalidate } from '../../realtime/index.js'
import { body, errorCode, signIn } from '../../test/api.js'
import { createFile, createPlay } from '../../test/catalog.js'
import { useTestDatabase } from '../../test/database.js'
import { createAlbum, createArtist, createLibraryRoot } from '../../test/factories.js'
import { smartPlaylistInvalidations } from './smart-refresh.js'
import { compileConditions, dailySeed, smartTracks, smartTracksQuery } from './smart.js'

vi.mock('../../realtime/index.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../realtime/index.js')>(),
  invalidate: vi.fn(async () => {}),
  publishChanges: vi.fn(async () => {}),
}))
const invalidated = vi.mocked(invalidate)

const rules = (conditions: SmartRule[], extra: Partial<SmartPlaylistRules> = {}): SmartPlaylistRules =>
  SmartPlaylistRules.parse({ source: 'server', match: 'all', conditions, sort: 'title', limit: null, ...extra })

describe('smart playlists', () => {
  useTestDatabase()
  let app: FastifyInstance
  let mira: Awaited<ReturnType<typeof signIn>>
  let lune: Awaited<ReturnType<typeof signIn>>
  /** A small server: three albums from two artists, every track with a file, plus one cached file. */
  let library: Awaited<ReturnType<typeof seed>>

  const call = (who: { headers: Record<string, string> }, options: InjectOptions) =>
    app.inject({ ...options, url: `/api/v1${options.url as string}`, headers: who.headers })

  async function seed() {
    const root = await createLibraryRoot()
    const beyonce = await createArtist({ name: 'Beyoncé' })
    const miles = await createArtist({ name: 'Miles Davis' })
    const lemonade = await createAlbum({ title: 'Lemonade', artist: beyonce, year: 2016, owned: true, rootId: root.id,
      tracks: [{ title: 'Formation', durationMs: 200_000 }, { title: 'Hold Up', durationMs: 220_000 }] })
    const blue = await createAlbum({ title: 'Kind of Blue', artist: miles, year: 1959, owned: true, rootId: root.id,
      tracks: [{ title: 'So What', durationMs: 560_000 }, { title: 'Blue in Green', durationMs: 330_000 }] })
    const bitches = await createAlbum({ title: 'Bitches Brew', artist: miles, year: 1970, owned: true, rootId: root.id,
      tracks: [{ title: 'Spanish Key', durationMs: 1_050_000 }] })
    await db.update(albums).set({ genres: ['R&B', 'Pop'] }).where(eq(albums.id, lemonade.albumId))
    await db.update(albums).set({ genres: ['Jazz', 'Modal Jazz'] }).where(eq(albums.id, blue.albumId))
    await db.update(albums).set({ genres: ['Jazz Fusion'] }).where(eq(albums.id, bitches.albumId))
    // One file is lossy and older; one track only fetched (cache), so it is no one's collection.
    await db.update(mediaFiles).set({ codec: 'mp3', lossless: false, bitrate: 320_000, sampleRate: 48_000, addedAt: new Date('2020-05-01T12:00:00Z') })
      .where(eq(mediaFiles.recordingId, blue.tracks[1]!.recordingId))
    const fetched = await createAlbum({ title: 'Fetched', artist: miles, year: 1961, owned: true, rootId: root.id, source: 'provider:test',
      tracks: [{ title: 'Cached Song' }] })
    const id = (album: Awaited<ReturnType<typeof createAlbum>>, index: number) => album.tracks[index]!.recordingId
    return {
      root, beyonce, miles, lemonade, blue, bitches, fetched,
      formation: id(lemonade, 0), holdUp: id(lemonade, 1), soWhat: id(blue, 0), blueInGreen: id(blue, 1), spanishKey: id(bitches, 0), cached: id(fetched, 0),
    }
  }

  /** The titles a rule set finds for mira, in order. */
  const titles = async (set: SmartPlaylistRules, userId = mira.id) => {
    const tracks = await smartTracks(userId, set, 'seed')
    const names = await db.execute<{ id: string; title: string }>(sql`select id, title from recordings`)
    const byId = new Map(names.map((row) => [row.id, row.title]))
    return tracks.map((track) => byId.get(track.id))
  }
  const one = (condition: SmartCondition) => titles(rules([condition]))

  beforeAll(async () => {
    app = await buildApp()
    mira = await signIn({ username: 'mira' })
    lune = await signIn({ username: 'lune' })
    library = await seed()
  })
  beforeEach(() => invalidated.mockClear())
  afterAll(async () => {
    await app.close()
  })

  describe('rules', () => {
    it('matches text the way search does, ignoring case and accents', async () => {
      expect(await one({ field: 'artist', op: 'is', value: 'beyonce' })).toEqual(['Formation', 'Hold Up'])
      expect(await one({ field: 'title', op: 'contains', value: 'BLUE' })).toEqual(['Blue in Green'])
      expect(await one({ field: 'title', op: 'notContains', value: 'blue' })).toEqual(['Formation', 'Hold Up', 'So What', 'Spanish Key'])
      expect(await one({ field: 'album', op: 'is', value: 'Kind of Blue' })).toEqual(['Blue in Green', 'So What'])
      expect(await one({ field: 'albumArtist', op: 'isNot', value: 'Miles Davis' })).toEqual(['Formation', 'Hold Up'])
      expect(await one({ field: 'genre', op: 'is', value: 'jazz' })).toEqual(['Blue in Green', 'So What'])
      expect(await one({ field: 'genre', op: 'contains', value: 'jazz' })).toEqual(['Blue in Green', 'So What', 'Spanish Key'])
      expect(await one({ field: 'codec', op: 'is', value: 'MP3' })).toEqual(['Blue in Green'])
    })

    it('compares numbers, decades and booleans', async () => {
      expect(await one({ field: 'year', op: 'lt', value: 1965 })).toEqual(['Blue in Green', 'So What'])
      expect(await one({ field: 'year', op: 'between', value: 1960, to: 2016 })).toEqual(['Formation', 'Hold Up', 'Spanish Key'])
      expect(await one({ field: 'year', op: 'ne', value: 1959 })).toEqual(['Formation', 'Hold Up', 'Spanish Key'])
      expect(await one({ field: 'decade', op: 'is', value: 1970 })).toEqual(['Spanish Key'])
      expect(await one({ field: 'decade', op: 'isNot', value: 1950 })).toEqual(['Formation', 'Hold Up', 'Spanish Key'])
      expect(await one({ field: 'durationMs', op: 'gt', value: 500_000 })).toEqual(['So What', 'Spanish Key'])
      expect(await one({ field: 'bitrateKbps', op: 'eq', value: 320 })).toEqual(['Blue in Green'])
      expect(await one({ field: 'sampleRateHz', op: 'gt', value: 44_100 })).toEqual(['Blue in Green'])
      expect(await one({ field: 'lossless', value: false })).toEqual(['Blue in Green'])
    })

    it('reads the owner\'s plays, hearts and ratings', async () => {
      await createPlay({ userId: mira.id, recordingId: library.soWhat, minutesAgo: 10 })
      await createPlay({ userId: mira.id, recordingId: library.soWhat, minutesAgo: 20 })
      await createPlay({ userId: mira.id, recordingId: library.formation, minutesAgo: 60 * 24 * 40 })
      // Skipped plays are not counted, though they are the last play.
      await createPlay({ userId: mira.id, recordingId: library.holdUp, minutesAgo: 5, completed: false })
      await createPlay({ userId: lune.id, recordingId: library.spanishKey })
      await db.insert(likes).values({ userId: mira.id, entityType: 'recording', entityId: library.holdUp })
      await db.insert(ratings).values({ userId: mira.id, entityType: 'recording', entityId: library.spanishKey, rating: 5 })

      expect(await one({ field: 'playCount', op: 'gt', value: 0 })).toEqual(['Formation', 'So What'])
      expect(await one({ field: 'playCount', op: 'eq', value: 0 })).toEqual(['Blue in Green', 'Hold Up', 'Spanish Key'])
      expect(await one({ field: 'lastPlayed', op: 'inLast', value: 1, unit: 'days' })).toEqual(['Hold Up', 'So What'])
      expect(await one({ field: 'lastPlayed', op: 'notInLast', value: 1, unit: 'weeks' })).toEqual(['Blue in Green', 'Formation', 'Spanish Key'])
      expect(await one({ field: 'liked', value: true })).toEqual(['Hold Up'])
      expect(await one({ field: 'rating', op: 'eq', value: 5 })).toEqual(['Spanish Key'])
      expect(await one({ field: 'rating', op: 'eq', value: 0 })).toHaveLength(4)
      expect(await titles(rules([], { sort: 'mostPlayed', limit: 2 }))).toEqual(['So What', 'Formation'])
      expect(await titles(rules([], { sort: 'recentlyPlayed', limit: 3 }))).toEqual(['Hold Up', 'So What', 'Formation'])
      // Lune's own numbers.
      expect(await titles(rules([{ field: 'playCount', op: 'gt', value: 0 }]), lune.id)).toEqual(['Spanish Key'])
      expect(await titles(rules([{ field: 'liked', value: true }]), lune.id)).toEqual([])
    })

    it('compares dates', async () => {
      expect(await one({ field: 'addedAt', op: 'before', value: '2021-01-01' })).toEqual(['Blue in Green'])
      expect(await one({ field: 'addedAt', op: 'after', value: '2020-05-01' })).toEqual(['Blue in Green', 'Formation', 'Hold Up', 'So What', 'Spanish Key'])
      expect(await one({ field: 'addedAt', op: 'after', value: '2020-05-02' })).toEqual(['Formation', 'Hold Up', 'So What', 'Spanish Key'])
      expect(await one({ field: 'addedAt', op: 'inLast', value: 1, unit: 'years' })).toEqual(['Formation', 'Hold Up', 'So What', 'Spanish Key'])
    })

    it('joins conditions and groups with all and any', async () => {
      const jazzOrBeyonce = rules([
        { field: 'genre', op: 'contains', value: 'jazz' },
        { field: 'artist', op: 'is', value: 'Beyoncé' },
      ], { match: 'any' })
      expect(await titles(jazzOrBeyonce)).toEqual(['Blue in Green', 'Formation', 'Hold Up', 'So What', 'Spanish Key'])
      const longModern = rules([
        { field: 'durationMs', op: 'gt', value: 210_000 },
        { match: 'any', conditions: [{ field: 'decade', op: 'is', value: 2010 }, { field: 'decade', op: 'is', value: 1970 }] },
      ])
      expect(await titles(longModern)).toEqual(['Hold Up', 'Spanish Key'])
    })

    it('keeps to the source: the server\'s collection, or the owner\'s library', async () => {
      // Cache is in nobody's collection.
      expect(await titles(rules([]))).not.toContain('Cached Song')
      // Mira's library is only what she hearted until the collection counts for her.
      await db.insert(likes).values({ userId: mira.id, entityType: 'album', entityId: library.bitches.albumId }).onConflictDoNothing()
      await db.insert(likes).values({ userId: mira.id, entityType: 'recording', entityId: library.cached }).onConflictDoNothing()
      expect(await titles(rules([], { source: 'library' }))).toEqual(['Cached Song', 'Hold Up', 'Spanish Key'])
      const opted = await signIn({ settings: { libraryIncludesServerMusic: true } })
      expect(await titles(rules([], { source: 'library' }), opted.id)).toEqual(['Blue in Green', 'Formation', 'Hold Up', 'So What', 'Spanish Key'])
      // A song with no present file does not play, so it is never listed.
      const unowned = await createAlbum({ title: 'Unowned', artist: library.miles, owned: false })
      await db.insert(likes).values({ userId: mira.id, entityType: 'album', entityId: unowned.albumId })
      expect(await titles(rules([], { source: 'library' }))).toEqual(['Cached Song', 'Hold Up', 'Spanish Key'])
    })

    it('sorts, limits, and shuffles the same way for one seed', async () => {
      expect(await titles(rules([], { sort: 'artist' }))).toEqual(['Formation', 'Hold Up', 'So What', 'Blue in Green', 'Spanish Key'])
      expect(await titles(rules([], { sort: 'year', limit: 2 }))).toEqual(['Formation', 'Hold Up'])
      expect(await titles(rules([], { sort: 'recentlyAdded' }))).toHaveLength(5)
      const shuffled = rules([], { sort: 'random' })
      const first = await smartTracks(mira.id, shuffled, 'a')
      expect(await smartTracks(mira.id, shuffled, 'a')).toEqual(first)
      const orders = await Promise.all(['b', 'c', 'd', 'e', 'f'].map(async (seed) => (await smartTracks(mira.id, shuffled, seed)).map((track) => track.id).join()))
      expect(new Set([first.map((track) => track.id).join(), ...orders]).size).toBeGreaterThan(1)
      expect(dailySeed('p', new Date('2026-11-28T23:59:00Z'))).toBe('p:2026-11-28')
    })

    it('lists each song once, through the newest file that passes', async () => {
      const second = await createFile({ rootId: library.root.id, recordingId: library.formation, albumId: library.lemonade.albumId, addedAt: new Date('2026-02-01T00:00:00Z') })
      const tracks = await smartTracks(mira.id, rules([{ field: 'title', op: 'is', value: 'Formation' }]), 'seed')
      expect(tracks).toEqual([{ id: library.formation, albumId: library.lemonade.albumId, addedAt: expect.any(String), durationMs: 200_000 }])
      await db.delete(mediaFiles).where(eq(mediaFiles.id, second))
    })
  })

  describe('safety', () => {
    const hostile = [
      `'); drop table users; --`,
      `x' or '1'='1`,
      `%`,
      `_`,
      `\\`,
      `$1`,
      `"; select pg_sleep(10); --`,
      `Robert'); DELETE FROM playlists WHERE ('a'='a`,
    ]

    it('binds every typed value as a parameter, never as statement text', () => {
      const dialect = new PgDialect()
      for (const value of hostile) {
        const conditions: SmartCondition[] = ['title', 'artist', 'albumArtist', 'album', 'genre', 'codec']
          .map((field) => ({ field, op: 'contains', value }) as SmartCondition)
        const set = rules([...conditions, { match: 'any', conditions }], { match: 'any' })
        const { sql: text, params } = dialect.sqlToQuery(smartTracksQuery(mira.id, set, value))
        // Short values (`_`, `$1`) are bits of any statement; the long ones must not be in it.
        if (value.length > 6) expect(text.toLowerCase()).not.toContain(value.toLowerCase())
        expect(params).toContain(value.toLowerCase())
      }
    })

    it('finds nothing, and harms nothing, with hostile text', async () => {
      for (const value of hostile) {
        expect(await one({ field: 'title', op: 'contains', value })).toEqual([])
        expect(await one({ field: 'genre', op: 'is', value })).toEqual([])
        expect(await one({ field: 'artist', op: 'isNot', value })).toHaveLength(5)
      }
      // A wildcard is a character, not a pattern.
      expect(await one({ field: 'codec', op: 'contains', value: '%' })).toEqual([])
      expect(await db.$count(playlists)).toBeGreaterThanOrEqual(0)
      expect((await db.execute(sql`select count(*)::int as n from users`))[0]).toMatchObject({ n: expect.any(Number) })
    })

    it('refuses rules outside the schema', () => {
      const bad: unknown[] = [
        { field: 'title; drop table users', op: 'is', value: 'x' },
        { field: 'title', op: 'like', value: 'x' },
        { field: 'title', op: 'is', value: '' },
        { field: 'title', op: 'is', value: 'x'.repeat(201) },
        { field: 'year', op: 'gt', value: '1990 or 1=1' },
        { field: 'year', op: 'gt', value: 1.5 },
        { field: 'year', op: 'between', value: 2000 },
        { field: 'year', op: 'between', value: 2000, to: 1990 },
        { field: 'decade', op: 'is', value: 1995 },
        { field: 'addedAt', op: 'inLast', value: 3 },
        { field: 'addedAt', op: 'before', value: 'yesterday' },
        { field: 'addedAt', op: 'inLast', value: '2020-01-01', unit: 'days' },
        { field: 'liked', value: 'true' },
        // Groups nest one level only.
        { match: 'all', conditions: [{ match: 'any', conditions: [{ field: 'liked', value: true }] }] },
      ]
      for (const condition of bad) {
        expect(SmartPlaylistRules.safeParse({ source: 'server', match: 'all', conditions: [condition], sort: 'title', limit: null }).success, JSON.stringify(condition)).toBe(false)
      }
      const many = Array.from({ length: 30 }, () => ({ field: 'liked', value: true }))
      expect(SmartPlaylistRules.safeParse({ source: 'server', match: 'all', conditions: [...many, { match: 'any', conditions: many }], sort: 'title', limit: null }).success).toBe(false)
      expect(SmartPlaylistRules.safeParse({ source: 'everything', match: 'all', conditions: [], sort: 'title', limit: null }).success).toBe(false)
      expect(SmartPlaylistRules.safeParse({ source: 'server', match: 'all', conditions: [], sort: 'r.id; drop', limit: null }).success).toBe(false)
      expect(SmartPlaylistRules.safeParse({ source: 'server', match: 'all', conditions: [], sort: 'title', limit: PLAYLIST_ITEM_LIMIT + 1 }).success).toBe(false)
    })

    it('treats no conditions as every song', () => {
      const { sql: text } = new PgDialect().sqlToQuery(compileConditions(rules([]), mira.id))
      expect(text).toBe('true')
    })
  })

  describe('routes', () => {
    const smart = (set: Record<string, unknown> = {}) => ({ source: 'server', match: 'all', conditions: [{ field: 'genre', op: 'contains', value: 'jazz' }], sort: 'title', limit: null, ...set })
    const create = async (who: typeof mira, payload: object) =>
      body(await call(who, { method: 'POST', url: '/playlists', payload }), PlaylistSummary, 201)

    it('creates a smart playlist whose songs, numbers and covers come from its rules', async () => {
      const summary = await create(mira, { name: 'Jazz', rules: smart() })
      expect(summary).toMatchObject({ name: 'Jazz', smart: true, trackCount: 3, durationMs: 560_000 + 330_000 + 1_050_000 })
      const detail = body(await call(mira, { url: `/playlists/${summary.id}` }), PlaylistDetail)
      expect(detail.rules).toEqual(SmartPlaylistRules.parse(smart()))
      expect(detail.items.map((item) => item.track.title)).toEqual(['Blue in Green', 'So What', 'Spanish Key'])
      expect(detail.items.map((item) => item.itemId)).toEqual(detail.items.map((item) => item.track.id))
      expect(detail.items[0]!.track.album?.id).toBe(library.blue.albumId)
      expect(body(await call(mira, { url: '/playlists' }), PlaylistPage).items.find((item) => item.id === summary.id)).toMatchObject({ smart: true, trackCount: 3 })
      // A playlist of songs says it is not smart.
      const plain = await create(mira, { name: 'Plain' })
      expect(plain.smart).toBe(false)
      expect(body(await call(mira, { url: `/playlists/${plain.id}` }), PlaylistDetail).rules).toBeNull()
    })

    it('follows the library as it changes', async () => {
      const summary = await create(mira, { name: 'Hearted', rules: smart({ source: 'library', conditions: [], sort: 'recentlyAdded' }) })
      const read = async () => body(await call(mira, { url: `/playlists/${summary.id}` }), PlaylistDetail).items.map((item) => item.track.title)
      const before = await read()
      body(await call(mira, { method: 'PUT', url: `/me/likes/album/${library.lemonade.albumId}` }), Ok)
      expect(await read()).toEqual(expect.arrayContaining([...before, 'Formation', 'Hold Up']))
    })

    it('evaluates a public smart playlist for its owner, whoever reads it', async () => {
      await db.insert(likes).values({ userId: lune.id, entityType: 'recording', entityId: library.soWhat }).onConflictDoNothing()
      const shared = await create(lune, { name: 'Lune likes', isPublic: true, rules: smart({ conditions: [{ field: 'liked', value: true }] }) })
      const seen = body(await call(mira, { url: `/playlists/${shared.id}` }), PlaylistDetail)
      expect(seen.items.map((item) => item.track.title)).toEqual(['So What'])
      // Summaries are still the reader's: mira did not heart it.
      expect(seen.items[0]!.track.liked).toBe(false)
      expect(errorCode(await call(mira, { method: 'PATCH', url: `/playlists/${shared.id}`, payload: { rules: smart() } }), 403)).toBe('forbidden')
    })

    it('keeps the kinds apart: no items on a smart playlist, no rules on one of songs', async () => {
      const summary = await create(mira, { name: 'Kinds', rules: smart() })
      const plain = await create(mira, { name: 'Songs' })
      const add = await call(mira, { method: 'POST', url: `/playlists/${summary.id}/items`, payload: { tracks: [{ trackId: library.formation }] } })
      expect(errorCode(add, 409)).toBe('smart_playlist')
      expect(errorCode(await call(mira, { method: 'POST', url: `/playlists/${summary.id}/items/move`, payload: { itemId: library.soWhat, toIndex: 0 } }), 409)).toBe('smart_playlist')
      expect(errorCode(await call(mira, { method: 'DELETE', url: `/playlists/${summary.id}/items/${library.soWhat}` }), 409)).toBe('smart_playlist')
      expect(errorCode(await call(mira, { method: 'PATCH', url: `/playlists/${plain.id}`, payload: { rules: smart() } }), 409)).toBe('not_smart_playlist')

      const updated = body(await call(mira, { method: 'PATCH', url: `/playlists/${summary.id}`, payload: { name: 'Fusion', rules: smart({ conditions: [{ field: 'genre', op: 'is', value: 'Jazz Fusion' }] }) } }), PlaylistSummary)
      expect(updated).toMatchObject({ name: 'Fusion', trackCount: 1, smart: true })
      expect(invalidated).toHaveBeenCalledWith({ user: mira.id }, [queryKeys.playlists(), queryKeys.libraryItems(), queryKeys.home()])
      body(await call(mira, { method: 'DELETE', url: `/playlists/${summary.id}` }), Ok)
    })

    it('refuses rules outside the schema', async () => {
      const response = await call(mira, { method: 'POST', url: '/playlists', payload: { name: 'Bad', rules: smart({ conditions: [{ field: 'sql', op: 'is', value: 'x' }] }) } })
      expect(ApiErrorBody.parse(response.json()).error.code).toBe('invalid_request')
      expect(response.statusCode).toBe(400)
    })

    it('previews rules without a playlist', async () => {
      const preview = body(await call(mira, { method: 'POST', url: '/playlists/smart/preview', payload: smart({ limit: 2 }) }), SmartPlaylistPreview)
      expect(preview).toEqual({ trackCount: 2, durationMs: 330_000 + 560_000 })
      expect(errorCode(await call(mira, { method: 'POST', url: '/playlists/smart/preview', payload: { source: 'server' } }), 400)).toBe('invalid_request')
    })
  })

  describe('refresh', () => {
    it('stales the smart playlists of whoever the library, a heart or a play changed', async () => {
      const own = await create(mira, { name: 'Own smart', rules: { source: 'library', match: 'all', conditions: [], sort: 'title', limit: null } })
      const shared = await create(mira, { name: 'Shared smart', isPublic: true, rules: { source: 'library', match: 'all', conditions: [], sort: 'title', limit: null } })
      await create(mira, { name: 'Songs only' })

      expect(await smartPlaylistInvalidations([{ user: mira.id }], [queryKeys.settings()])).toEqual([])
      const mine = await smartPlaylistInvalidations([{ user: mira.id }], [queryKeys.history()])
      expect(mine).toEqual(expect.arrayContaining([
        ['all', expect.arrayContaining([queryKeys.playlist(shared.id)])],
        [{ user: mira.id }, expect.arrayContaining([queryKeys.playlist(own.id)])],
      ]))
      expect(JSON.stringify(mine)).not.toContain('Songs only')
      const everyone = await smartPlaylistInvalidations(['all'], [queryKeys.library()])
      expect(everyone).toEqual([['all', expect.arrayContaining([queryKeys.playlist(own.id), queryKeys.playlist(shared.id)])]])
      // Nobody else's change stales mira's.
      const others = await smartPlaylistInvalidations([{ user: lune.id }], [queryKeys.likes()])
      expect(JSON.stringify(others)).not.toContain(own.id)
    })

    async function create(who: typeof mira, payload: object) {
      return body(await call(who, { method: 'POST', url: '/playlists', payload }), PlaylistSummary, 201)
    }
  })
})
