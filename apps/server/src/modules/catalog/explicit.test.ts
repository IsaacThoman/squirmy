import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { AlbumDetail, HomeResponse, PlaybackDescriptor, RadioResponse, SearchResults, User, UserList, UserSettings } from '@squirmy/contracts'
import { eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { buildApp } from '../../app.js'
import { resetConfig } from '../../config.js'
import { db } from '../../database/client.js'
import { mediaFiles } from '../../database/schema.js'
import { clearReadCache } from '../../lib/read-cache.js'
import { updateServerSettings } from '../../lib/settings.js'
import { startJobs, stopJobs } from '../../jobs/index.js'
import { body, errorCode, signIn } from '../../test/api.js'
import { makeTone } from '../../test/audio.js'
import { createPlay } from '../../test/catalog.js'
import { useTestDatabase } from '../../test/database.js'
import { createAlbum, createArtist, createLibraryRoot } from '../../test/factories.js'
import { subsonicClient, type SubsonicClient } from '../../test/subsonic-client.js'
import { createAppPassword } from '../auth/service.js'
import { suggest } from '../radio/ranking.js'
import { trustSeeds } from '../sessions/entries.js'
import { signStreamUrl } from '../streaming/playback.js'
import { albumId as subsonicAlbumId, trackId as subsonicTrackId } from '../subsonic/ids.js'
import { cleanVersions } from './explicit.js'

describe('explicit content controls', () => {
  useTestDatabase()
  let app: FastifyInstance
  let root: string
  let admin: Awaited<ReturnType<typeof signIn>>
  /** Restricted by an admin, as a child's account would be. */
  let kid: Awaited<ReturnType<typeof signIn>> & { subsonic: SubsonicClient }
  /** Explicit content allowed: the default. */
  let adult: Awaited<ReturnType<typeof signIn>> & { subsonic: SubsonicClient }
  /** Loud Room: "Bad Words" (explicit, with a clean version), "Soft" (clean), "Plain" (unknown). */
  let loud: Awaited<ReturnType<typeof createAlbum>>
  /** Loud Room (Clean): "Bad Words (Clean)". */
  let clean: Awaited<ReturnType<typeof createAlbum>>
  /** Curses: "Curse" (explicit, no clean version), on a real tone file. */
  let curses: Awaited<ReturnType<typeof createAlbum>>

  const get = (user: { headers: Record<string, string> }, url: string) => app.inject({ url: `/api/v1${url}`, headers: user.headers })
  const patch = (user: { headers: Record<string, string> }, url: string, payload: object) =>
    app.inject({ method: 'PATCH', url: `/api/v1${url}`, headers: user.headers, payload })
  const albumTracks = async (user: { headers: Record<string, string> }, id: string) =>
    body(await get(user, `/albums/${id}`), AlbumDetail).discs.flatMap((disc) => disc.tracks)
  const withSubsonic = async (user: Awaited<ReturnType<typeof signIn>>) => {
    const { secret } = await createAppPassword(user.id, 'Subsonic')
    return { ...user, subsonic: subsonicClient(app, { username: user.username, secret: secret! }) }
  }

  beforeAll(async () => {
    // Cached reads are per user: one user's filtered page must never answer for another.
    process.env.SQUIRMY_READ_CACHE_MB = '16'
    resetConfig()
    await startJobs({ work: false })
    app = await buildApp()
    await updateServerSettings({ deezerEnabled: false })
    admin = await signIn({ role: 'admin' })
    kid = await withSubsonic(await signIn({ username: 'kid', settings: { libraryIncludesServerMusic: true } }))
    adult = await withSubsonic(await signIn({ username: 'adult', settings: { libraryIncludesServerMusic: true } }))

    root = await mkdtemp(path.join(tmpdir(), 'squirmy-explicit-'))
    const rootId = (await createLibraryRoot({ path: root })).id
    const wren = await createArtist({ name: 'Wren Ash' })
    loud = await createAlbum({
      title: 'Loud Room', artist: wren, owned: true, rootId,
      tracks: [{ title: 'Bad Words', explicit: true }, { title: 'Soft', explicit: false }, { title: 'Plain' }],
    })
    clean = await createAlbum({ title: 'Loud Room (Clean)', artist: wren, owned: true, rootId, tracks: [{ title: 'Bad Words (Clean)', explicit: false }] })
    curses = await createAlbum({ title: 'Curses', artist: wren, owned: true, rootId, tracks: [{ title: 'Curse', explicit: true }] })
    // A real file, with the advisory tag a store writes, so the stream route has bytes to send.
    await makeTone(root, { path: 'Wren Ash/Curses/01 Curse.flac', durationSec: 1, tags: { title: 'Curse', artist: 'Wren Ash', ITUNESADVISORY: 1 } })
    const bytes = await readFile(path.join(root, 'Wren Ash/Curses/01 Curse.flac'))
    await db.update(mediaFiles).set({ relPath: 'Wren Ash/Curses/01 Curse.flac', size: bytes.length, durationMs: 1000, tags: { title: 'Curse', artist: 'Wren Ash', explicit: true } })
      .where(eq(mediaFiles.id, curses.tracks[0]!.fileId!))

    const restricted = await patch(admin, `/admin/users/${kid.id}`, { explicitRestricted: true })
    expect(body(restricted, User)).toMatchObject({ explicitRestricted: true, allowsExplicit: false })
  })
  afterAll(async () => {
    await app.close()
    await stopJobs()
    await rm(root, { recursive: true, force: true })
    delete process.env.SQUIRMY_READ_CACHE_MB
    resetConfig()
  })
  beforeEach(() => clearReadCache())

  describe('settings', () => {
    it('allows explicit content by default and lets a user turn it off for themselves', async () => {
      const user = await signIn()
      expect(body(await get(user, '/me/settings'), UserSettings).allowExplicit).toBe(true)
      expect(body(await get(user, '/auth/me'), User)).toMatchObject({ explicitRestricted: false, allowsExplicit: true })
      expect(body(await patch(user, '/me/settings', { allowExplicit: false }), UserSettings).allowExplicit).toBe(false)
      expect(body(await get(user, '/auth/me'), User).allowsExplicit).toBe(false)
      expect(body(await patch(user, '/me/settings', { allowExplicit: true }), UserSettings).allowExplicit).toBe(true)
      expect(body(await get(user, '/auth/me'), User).allowsExplicit).toBe(true)
    })

    it('keeps an admin restriction: the user cannot turn explicit content back on', async () => {
      expect(body(await get(kid, '/auth/me'), User)).toMatchObject({ explicitRestricted: true, allowsExplicit: false })
      expect(errorCode(await patch(kid, '/me/settings', { allowExplicit: true }), 403)).toBe('explicit_restricted')
      // Turning it off, and every other setting, still works.
      expect(body(await patch(kid, '/me/settings', { allowExplicit: false, shareNowPlaying: true }), UserSettings)).toMatchObject({ allowExplicit: false, shareNowPlaying: true })
      const listed = body(await get(admin, '/admin/users'), UserList).items.find((user) => user.id === kid.id)
      expect(listed).toMatchObject({ explicitRestricted: true, allowsExplicit: false })
    })

    it('applies the user\'s own choice once the restriction is lifted, and only admins can change it', async () => {
      const user = await signIn()
      expect(errorCode(await patch(user, `/admin/users/${user.id}`, { explicitRestricted: false }), 403)).toBe('forbidden')
      await patch(user, '/me/settings', { allowExplicit: false })
      expect(body(await patch(admin, `/admin/users/${user.id}`, { explicitRestricted: true }), User).allowsExplicit).toBe(false)
      // Lifting the restriction leaves the user's own setting, which is off.
      expect(body(await patch(admin, `/admin/users/${user.id}`, { explicitRestricted: false }), User)).toMatchObject({ explicitRestricted: false, allowsExplicit: false })
      expect(body(await patch(user, '/me/settings', { allowExplicit: true }), UserSettings).allowExplicit).toBe(true)
      expect(body(await get(user, '/auth/me'), User).allowsExplicit).toBe(true)
    })

    it('lets an admin create a restricted account', async () => {
      const created = await app.inject({
        method: 'POST', url: '/api/v1/admin/users', headers: admin.headers,
        payload: { username: 'little', password: 'little password', explicitRestricted: true },
      })
      expect(body(created, User, 201)).toMatchObject({ explicitRestricted: true, allowsExplicit: false })
    })
  })

  describe('clean versions', () => {
    it('finds a known clean version by artist, title without edition words, and length', async () => {
      const versions = await cleanVersions([loud.tracks[0]!.recordingId, curses.tracks[0]!.recordingId])
      expect(versions.get(loud.tracks[0]!.recordingId)).toEqual([clean.tracks[0]!.recordingId])
      expect(versions.has(curses.tracks[0]!.recordingId)).toBe(false)
    })

    it('takes no version whose flag is unknown: it may be the explicit recording under another row', async () => {
      const wren = { id: loud.artist.id, name: loud.artist.name }
      const unknown = await createAlbum({ title: 'Curses (Live Session)', artist: wren, tracks: [{ title: 'Curse' }] })
      expect((await cleanVersions([curses.tracks[0]!.recordingId])).has(curses.tracks[0]!.recordingId)).toBe(false)
      expect(unknown.tracks).toHaveLength(1)
    })

    it('shows the clean version in an explicit song\'s place on the album page, and the explicit one to everyone else', async () => {
      const forKid = await albumTracks(kid, loud.albumId)
      expect(forKid.map((track) => [track.id, track.position, track.explicit])).toEqual([
        [clean.tracks[0]!.recordingId, 1, false],
        [loud.tracks[1]!.recordingId, 2, false],
        [loud.tracks[2]!.recordingId, 3, null],
      ])
      expect(forKid[0]!.album?.id).toBe(loud.albumId)
      const forAdult = await albumTracks(adult, loud.albumId)
      expect(forAdult.map((track) => [track.id, track.explicit])).toEqual([
        [loud.tracks[0]!.recordingId, true], [loud.tracks[1]!.recordingId, false], [loud.tracks[2]!.recordingId, null],
      ])
      // A song with no clean version stays, for the client to gray.
      expect((await albumTracks(kid, curses.albumId)).map((track) => track.explicit)).toEqual([true])
    })
  })

  describe('playback', () => {
    it('drops explicit tracks from trusted entries, or plays a clean version in their place', async () => {
      const seeds = [loud.tracks[0]!, curses.tracks[0]!, loud.tracks[1]!].map((track) => ({ trackId: track.recordingId, albumId: loud.albumId, durationMs: 0 }))
      const forKid = await trustSeeds(kid.id, seeds)
      expect(forKid.seeds.map((seed) => [seed.trackId, seed.albumId])).toEqual([[clean.tracks[0]!.recordingId, null], [loud.tracks[1]!.recordingId, loud.albumId]])
      expect(forKid.indexes).toEqual([0, 2])
      const forAdult = await trustSeeds(adult.id, seeds)
      expect(forAdult.seeds.map((seed) => seed.trackId)).toEqual(seeds.map((seed) => seed.trackId))
    })

    it('refuses the playback descriptor and the stream of an explicit file', async () => {
      const curse = curses.tracks[0]!
      expect(errorCode(await get(kid, `/tracks/${curse.recordingId}/playback`), 403)).toBe('explicit_not_allowed')
      expect(errorCode(await get(kid, `/stream/${curse.fileId}`), 403)).toBe('explicit_not_allowed')
      const descriptor = body(await get(adult, `/tracks/${curse.recordingId}/playback`), PlaybackDescriptor)
      expect((await app.inject({ url: descriptor.url })).statusCode).toBe(200)
      // A URL signed before the user was restricted is refused too.
      expect(errorCode(await app.inject({ url: signStreamUrl(curse.fileId!, 'original', kid.id).url }), 403)).toBe('explicit_not_allowed')
    })

    it('goes by the file\'s own advisory: a file tagged clean plays though the catalog says explicit', async () => {
      const wren = { id: loud.artist.id, name: loud.artist.name }
      const edited = await createAlbum({ title: 'Edited', artist: wren, owned: true, tracks: [{ title: 'Radio Edit', explicit: true }] })
      await db.update(mediaFiles).set({ tags: { title: 'Radio Edit', explicit: false } }).where(eq(mediaFiles.id, edited.tracks[0]!.fileId!))
      expect((await get(kid, `/tracks/${edited.tracks[0]!.recordingId}/playback`)).statusCode).toBe(200)
    })

    it('keeps explicit songs out of radio and autoplay', async () => {
      expect(errorCode(await app.inject({ method: 'POST', url: `/api/v1/radio/track/${curses.tracks[0]!.recordingId}`, headers: kid.headers }), 409)).toBe('not_playable')
      const explicitIds = new Set([loud.tracks[0]!.recordingId, curses.tracks[0]!.recordingId])
      const forKid = await suggest({ userId: kid.id, seeds: [loud.tracks[1]!.recordingId], exclude: [], limit: 10 }, { random: () => 0.5 })
      expect(forKid.length).toBeGreaterThan(0)
      expect(forKid.filter((seed) => explicitIds.has(seed.trackId))).toEqual([])
      const forAdult = await suggest({ userId: adult.id, seeds: [loud.tracks[1]!.recordingId], exclude: [], limit: 10 }, { random: () => 0.5 })
      expect(forAdult.some((seed) => explicitIds.has(seed.trackId))).toBe(true)
      // An artist radio starts from a song the user may hear.
      const radio = body(await app.inject({ method: 'POST', url: `/api/v1/radio/artist/${loud.artist.id}`, headers: kid.headers }), RadioResponse)
      expect(radio.tracks.filter((seed) => explicitIds.has(seed.trackId))).toEqual([])
    })
  })

  describe('lists', () => {
    it('hides explicit songs from search', async () => {
      const kidResults = body(await get(kid, '/search/library?q=bad%20words&scope=server'), SearchResults)
      expect(kidResults.tracks.map((track) => track.id)).toEqual([clean.tracks[0]!.recordingId])
      expect(kidResults.ranked?.some((item) => item.id === loud.tracks[0]!.recordingId)).toBe(false)
      const adultResults = body(await get(adult, '/search/library?q=bad%20words&scope=server'), SearchResults)
      expect(adultResults.tracks.map((track) => track.id)).toContain(loud.tracks[0]!.recordingId)
    })

    it('hides explicit songs from Home\'s most played', async () => {
      for (const user of [kid, adult]) {
        await createPlay({ userId: user.id, recordingId: curses.tracks[0]!.recordingId, albumId: curses.albumId })
        await createPlay({ userId: user.id, recordingId: loud.tracks[1]!.recordingId, albumId: loud.albumId })
      }
      const mostPlayed = async (user: { headers: Record<string, string> }) => {
        const section = body(await get(user, '/home'), HomeResponse).sections.find((one) => one.id === 'most-played')
        return section?.kind === 'tracks' ? section.tracks.map((track) => track.id).sort() : []
      }
      expect(await mostPlayed(kid)).toEqual([loud.tracks[1]!.recordingId])
      expect(await mostPlayed(adult)).toEqual([curses.tracks[0]!.recordingId, loud.tracks[1]!.recordingId].sort())
    })

    it('leaves explicit songs out of Subsonic and refuses their stream', async () => {
      const songTitles = async (client: SubsonicClient) =>
        ((await client.call('getAlbum', { id: subsonicAlbumId(loud.albumId) })).album.song as { title: string }[]).map((song) => song.title)
      expect(await songTitles(kid.subsonic)).toEqual(['Soft', 'Plain'])
      expect(await songTitles(adult.subsonic)).toEqual(['Bad Words', 'Soft', 'Plain'])
      const found = (await kid.subsonic.call('search3', { query: 'curse' })).searchResult3.song ?? []
      expect(found).toEqual([])
      expect(await kid.subsonic.error('getSong', { id: subsonicTrackId(curses.tracks[0]!.recordingId) })).toBe(70)
      expect(await kid.subsonic.error('stream', { id: subsonicTrackId(curses.tracks[0]!.recordingId) })).toBe(50)
      expect((await adult.subsonic.raw('stream', { id: subsonicTrackId(curses.tracks[0]!.recordingId) })).statusCode).toBe(200)
    })

    it('reads cached pages again when explicit content is turned on or off, and never shares one user\'s', async () => {
      const user = await signIn({ settings: { libraryIncludesServerMusic: true } })
      expect((await albumTracks(user, loud.albumId))[0]!.id).toBe(loud.tracks[0]!.recordingId)
      await patch(user, '/me/settings', { allowExplicit: false })
      expect((await albumTracks(user, loud.albumId))[0]!.id).toBe(clean.tracks[0]!.recordingId)
      // The adult's cached page is still the explicit one, and the kid's the clean one.
      expect((await albumTracks(adult, loud.albumId))[0]!.id).toBe(loud.tracks[0]!.recordingId)
      expect((await albumTracks(kid, loud.albumId))[0]!.id).toBe(clean.tracks[0]!.recordingId)
      await patch(user, '/me/settings', { allowExplicit: true })
      expect((await albumTracks(user, loud.albumId))[0]!.id).toBe(loud.tracks[0]!.recordingId)
      // An admin's restriction drops the cached page too.
      await patch(admin, `/admin/users/${user.id}`, { explicitRestricted: true })
      expect((await albumTracks(user, loud.albumId))[0]!.id).toBe(clean.tracks[0]!.recordingId)
    })
  })
})
