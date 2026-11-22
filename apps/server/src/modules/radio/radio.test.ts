import { RadioResponse, type QueueSeed } from '@squirmy/contracts'
import { and, eq, inArray, sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildApp } from '../../app.js'
import { db } from '../../database/client.js'
import { albums, externalIds, likes, recordingArtists, recordings } from '../../database/schema.js'
import { newId } from '../../lib/ids.js'
import { updateServerSettings } from '../../lib/settings.js'
import { body, errorCode, signIn } from '../../test/api.js'
import { createPlay } from '../../test/catalog.js'
import { useTestDatabase } from '../../test/database.js'
import { createAlbum, createArtist, createUser } from '../../test/factories.js'
import { useHttpFixtures } from '../../test/http.js'
import { suggest, WINDOW } from './ranking.js'
import { similarArtists } from './similar.js'
import { suggestAutoplay } from './suggest.js'

const onDemand = vi.hoisted(() => new Set<string>())
vi.mock('../acquisition/coverage.js', () => ({
  onDemandRecordings: vi.fn(async (ids: readonly string[]) => new Set(ids.filter((id) => onDemand.has(id)))),
  requestRecording: vi.fn(async () => {}),
}))

/** A small seeded generator (mulberry32), so ranking runs can be repeated. */
function seeded(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

type Track = { recordingId: string; albumId: string; artistId: string; genre: string; owned: boolean }

const radiohead = 'a74b1b7f-71a5-4011-9441-d0b5e4122711'

describe('radio', () => {
  useTestDatabase()
  const http = useHttpFixtures('deezer', 'listenbrainz')
  const tracks: Track[] = []
  const byId = (id: string) => {
    const track = tracks.find((one) => one.recordingId === id)
    // Every owned track a test creates must be listed, or a suggestion of it fails here.
    if (!track) throw new Error(`Suggested ${id}, which no test listed in tracks`)
    return track
  }
  let seed: Track
  let app: FastifyInstance

  async function shelf(name: string, genre: string, year: number, albumCount: number, options: { owned?: boolean; mbid?: string; artist?: { id: string; name: string } } = {}) {
    const owned = options.owned ?? true
    const artist = options.artist ?? await createArtist({ name, mbid: options.mbid })
    for (let index = 0; index < albumCount; index++) {
      const created = await createAlbum({
        artist, year, owned,
        title: `${name} ${index + 1}`,
        tracks: Array.from({ length: 4 }, (_, position) => ({ title: `${name} ${index + 1}.${position + 1}` })),
      })
      await db.update(albums).set({ genres: [genre] }).where(eq(albums.id, created.albumId))
      tracks.push(...created.tracks.map((track) => ({ recordingId: track.recordingId, albumId: created.albumId, artistId: artist.id, genre, owned })))
    }
    return artist
  }

  beforeAll(async () => {
    // Every external source is off unless a test turns one on.
    await updateServerSettings({ deezerEnabled: false })
    const rockA = await shelf('Rock A', 'Rock', 1997, 2)
    for (const name of ['Rock B', 'Rock C', 'Rock D', 'Rock E', 'Rock F']) await shelf(name, 'Rock', 1997, 2)
    for (const name of ['Jazz A', 'Jazz B', 'Jazz C']) await shelf(name, 'Jazz', 1961, 2)
    await shelf('Rock A unowned', 'Rock', 1997, 4, { owned: false, artist: rockA })
    seed = tracks[0]!
    app = await buildApp()
  })
  afterAll(async () => {
    await app.close()
  })
  beforeEach(() => onDemand.clear())

  const run = async (userId: string, options: { random?: number; seeds?: string[]; exclude?: string[]; limit?: number } = {}) =>
    suggest({ userId, seeds: options.seeds ?? [seed.recordingId], exclude: options.exclude ?? [], limit: options.limit ?? WINDOW }, { random: seeded(options.random ?? 1) })

  it('suggests owned tracks only, never a seed or an excluded track', async () => {
    const user = await createUser()
    const exclude = tracks.filter((track) => track.artistId !== seed.artistId).slice(0, 6).map((track) => track.recordingId)
    for (const random of [1, 2, 3]) {
      const result = await run(user.id, { random, exclude })
      expect(result).toHaveLength(WINDOW)
      for (const item of result) {
        expect(byId(item.trackId).owned).toBe(true)
        expect(item).toMatchObject({ state: 'ready', albumId: byId(item.trackId).albumId })
        expect(item.durationMs).toBeGreaterThan(0)
        expect([seed.recordingId, ...exclude]).not.toContain(item.trackId)
      }
    }
  })

  it('keeps variety: two tracks per artist, one per album, never the same artist twice in a row', async () => {
    const user = await createUser()
    for (const random of [1, 2, 3, 4]) {
      const result = (await run(user.id, { random })).map((item) => byId(item.trackId))
      const count = (key: 'artistId' | 'albumId') => Math.max(...result.map((track) => result.filter((other) => other[key] === track[key]).length))
      expect(count('artistId')).toBeLessThanOrEqual(2)
      expect(count('albumId')).toBe(1)
      for (const [index, track] of result.entries()) {
        expect(track.artistId).not.toBe(index === 0 ? seed.artistId : result[index - 1]!.artistId)
      }
    }
  })

  it('ranks by genre and era with no external source and no history, making no requests', async () => {
    const user = await createUser()
    const result = await suggestAutoplay({ userId: user.id, seeds: [seed.recordingId], exclude: [], limit: WINDOW })
    expect(result).toHaveLength(WINDOW)
    expect(result.map((item) => byId(item.trackId).genre)).toEqual(Array(WINDOW).fill('Rock'))
    expect(http.requests).toEqual([])
  })

  it('boosts liked tracks', async () => {
    const user = await createUser()
    const liked = tracks.find((track) => track.genre === 'Rock' && track.artistId !== seed.artistId && track.owned)!
    await db.insert(likes).values({ userId: user.id, entityType: 'recording', entityId: liked.recordingId })
    for (const random of [1, 2, 3, 4, 5]) expect((await run(user.id, { random }))[0]!.trackId).toBe(liked.recordingId)
  })

  it('avoids tracks played in the last few hours', async () => {
    const user = await createUser()
    const rock = tracks.filter((track) => track.genre === 'Rock' && track.owned && track.artistId !== seed.artistId)
    const recent = rock.slice(0, 8)
    for (const track of recent) await createPlay({ userId: user.id, recordingId: track.recordingId, minutesAgo: 30 })
    for (const random of [1, 2, 3]) {
      const result = await run(user.id, { random })
      expect(result.filter((item) => recent.some((track) => track.recordingId === item.trackId))).toEqual([])
    }
  })

  it('suggests what the user played around the seed', async () => {
    const user = await createUser()
    const jazz = tracks.find((track) => track.genre === 'Jazz')!
    // On four earlier days the user played the seed and, right after, a jazz track.
    for (const day of [1, 2, 3, 4]) {
      await createPlay({ userId: user.id, recordingId: seed.recordingId, minutesAgo: day * 24 * 60 })
      await createPlay({ userId: user.id, recordingId: jazz.recordingId, minutesAgo: day * 24 * 60 - 4 })
    }
    for (const random of [1, 2, 3]) expect((await run(user.id, { random }))[0]!.trackId).toBe(jazz.recordingId)
  })

  it('is repeatable under a seeded random source and varies across seeds', async () => {
    const user = await createUser()
    const first = await run(user.id, { random: 7 })
    expect(await run(user.id, { random: 7 })).toEqual(first)
    const others = await Promise.all([8, 9, 10].map((random) => run(user.id, { random })))
    expect(others.some((other) => JSON.stringify(other) !== JSON.stringify(first))).toBe(true)
  })

  it('ends a batch early rather than fill it with unrelated tracks past one window', async () => {
    const user = await createUser()
    const jazz = tracks.find((track) => track.genre === 'Jazz')!
    const result = await run(user.id, { seeds: [jazz.recordingId], limit: 40 })
    // Two dozen jazz tracks, then nothing: the rock shelves share neither genre nor era.
    expect(result.length).toBeLessThan(40)
    // Within the first window a rock track may stand in where the variety rules leave no
    // jazz one (three jazz artists cannot fill ten slots alone); never after it.
    expect(result.filter((item) => byId(item.trackId).genre !== 'Jazz').length).toBeLessThanOrEqual(1)
    expect(result.slice(WINDOW).map((item) => byId(item.trackId).genre).every((genre) => genre === 'Jazz')).toBe(true)
  })

  it('fills a short batch up to one window with what is left', async () => {
    const user = await createUser()
    const rock = tracks.filter((track) => track.owned && track.genre === 'Rock' && track.recordingId !== seed.recordingId)
    // One rock track of each of four other artists.
    const kept = [...new Map(rock.filter((track) => track.artistId !== seed.artistId).map((track) => [track.artistId, track])).values()].slice(0, 4)
    const result = await run(user.id, { exclude: rock.filter((track) => !kept.includes(track)).map((track) => track.recordingId) })
    expect(result).toHaveLength(WINDOW)
    // The related ones first, then the jazz shelves.
    expect(result.slice(0, 4).map((item) => byId(item.trackId).genre)).toEqual(Array(4).fill('Rock'))
    expect(result.slice(4).every((item) => byId(item.trackId).genre === 'Jazz')).toBe(true)
  })

  it('ignores a track played near the seed on one day only, and a liked track of another genre', async () => {
    const user = await createUser()
    const [jazz, liked] = tracks.filter((track) => track.genre === 'Jazz')
    // One afternoon: the seed and right after it the same jazz track, again and again.
    for (const minutes of [300, 240, 180, 120]) {
      await createPlay({ userId: user.id, recordingId: seed.recordingId, minutesAgo: 24 * 60 + minutes })
      await createPlay({ userId: user.id, recordingId: jazz!.recordingId, minutesAgo: 24 * 60 + minutes - 4 })
    }
    await db.insert(likes).values({ userId: user.id, entityType: 'recording', entityId: liked!.recordingId })
    for (const random of [1, 2, 3]) {
      const result = (await run(user.id, { random })).map((item) => item.trackId)
      expect(result).not.toContain(jazz!.recordingId)
      expect(result).not.toContain(liked!.recordingId)
    }
  })

  describe('on-demand tracks', () => {
    // A server holding three owned tracks: the seed and two others that can follow it.
    const library = () => {
      const others = tracks.filter((track) => track.owned && track.recordingId !== seed.recordingId)
      const kept = [others.find((track) => track.genre === 'Rock' && track.artistId !== seed.artistId)!, others.find((track) => track.genre === 'Jazz')!]
      return { kept: kept.map((track) => track.recordingId), exclude: others.filter((track) => !kept.includes(track)).map((track) => track.recordingId) }
    }
    beforeEach(() => {
      for (const track of tracks.filter((one) => !one.owned)) onDemand.add(track.recordingId)
    })

    it('ranks them with owned tracks for a requester; an owned track takes the first pick from a near tie', async () => {
      const rockB = tracks.find((track) => track.owned && track.genre === 'Rock' && track.artistId !== seed.artistId)!
      const rockC = tracks.find((track) => track.owned && track.genre === 'Rock' && ![seed.artistId, rockB.artistId].includes(track.artistId))!
      const unowned = tracks.filter((track) => !track.owned && track.artistId === seed.artistId)
      // Rock C's owned track and Rock A's unowned ones share the genre and year, and the user
      // likes them all: only noise tells them apart.
      const exclude = tracks.filter((track) => track.owned && track !== rockC).map((track) => track.recordingId)
      for (const user of [await createUser({ canAcquire: true }), await createUser({ role: 'admin' })]) {
        await db.insert(likes).values([rockC, ...unowned].map((track) => ({ userId: user.id, entityType: 'recording' as const, entityId: track.recordingId })))
        for (const random of [1, 2, 3, 4, 5, 6]) {
          const result = await run(user.id, { random, seeds: [rockB.recordingId], exclude })
          expect(result[0]).toMatchObject({ trackId: rockC.recordingId, state: 'ready' })
          expect(result.length).toBeGreaterThan(3)
          expect(result.slice(1).every((item) => item.state === 'preparing' && !byId(item.trackId).owned)).toBe(true)
        }
      }
    })

    it('does not prefer an owned track that is not close to the best', async () => {
      const user = await createUser({ canAcquire: true })
      const rockB = tracks.find((track) => track.owned && track.genre === 'Rock' && track.artistId !== seed.artistId)!
      const rockC = tracks.find((track) => track.owned && track.genre === 'Rock' && ![seed.artistId, rockB.artistId].includes(track.artistId))!
      // The user likes the seed artist and one of its songs the server does not have.
      const liked = tracks.find((track) => !track.owned && track.artistId === seed.artistId)!
      await db.insert(likes).values([
        { userId: user.id, entityType: 'artist', entityId: seed.artistId },
        { userId: user.id, entityType: 'recording', entityId: liked.recordingId },
      ])
      const exclude = tracks.filter((track) => track.owned && ![rockB, rockC].includes(track)).map((track) => track.recordingId)
      for (const random of [1, 2, 3]) {
        const [first] = await run(user.id, { random, seeds: [rockB.recordingId], exclude })
        expect(first).toMatchObject({ trackId: liked.recordingId, state: 'preparing' })
      }
    })

    it('suggests them first for a requester when nothing owned qualifies', async () => {
      const user = await createUser({ canAcquire: true })
      const result = await run(user.id, { exclude: tracks.filter((track) => track.owned).map((track) => track.recordingId) })
      expect(result).toHaveLength(WINDOW)
      expect(result.every((item) => item.state === 'preparing')).toBe(true)
      onDemand.clear()
      expect(await run(user.id, { exclude: tracks.filter((track) => track.owned).map((track) => track.recordingId) })).toEqual([])
    })

    it('never suggests them to a user who may not have tracks fetched', async () => {
      const { kept, exclude } = library()
      const user = await createUser()
      const result = await run(user.id, { exclude })
      expect(result.map((item) => item.trackId).toSorted()).toEqual(kept.toSorted())
      expect(result.every((item) => item.state === 'ready')).toBe(true)
      expect(await run(user.id, { exclude: tracks.filter((track) => track.owned).map((track) => track.recordingId) })).toEqual([])
    })

    it('counts tracks an artist leads without credit rows as the artist\'s', async () => {
      const user = await createUser({ canAcquire: true })
      const artist = await createArtist({ name: 'Uncredited lead' })
      const owned = await createAlbum({ artist, owned: true, tracks: [{ title: 'Led 1' }] })
      const remote = [await createAlbum({ artist, tracks: [{ title: 'Led 2' }] }), await createAlbum({ artist, tracks: [{ title: 'Led 3' }] })]
      for (const album of [owned, ...remote]) {
        tracks.push(...album.tracks.map((track) => ({ recordingId: track.recordingId, albumId: album.albumId, artistId: artist.id, genre: 'None', owned: album === owned })))
      }
      // Rows from older imports and catalog stubs can carry only the primary artist.
      const led = remote.map((album) => album.tracks[0]!.recordingId)
      await db.delete(recordingArtists).where(inArray(recordingArtists.recordingId, [owned.tracks[0]!.recordingId, ...led]))
      for (const id of led) onDemand.add(id)
      // On-demand candidates come from the artist, similar-artist and liked pools only.
      const result = await run(user.id, { seeds: [owned.tracks[0]!.recordingId] })
      expect(result.map((item) => item.trackId)).toEqual(expect.arrayContaining(led))
    })
  })

  it('treats seeds and excluded ids that were merged away as the tracks they became', async () => {
    const user = await createUser()
    // A queue keeps the ids it was given; a later merge leaves them redirecting.
    const alias = new Map<string, string>()
    for (const track of tracks.filter((one) => one.owned)) {
      const id = newId()
      await db.insert(recordings).values({ id, title: 'Old', artistCredit: 'x', titleKey: 'old', matchKey: 'x|old', mergedIntoId: track.recordingId })
      alias.set(track.recordingId, id)
    }
    const others = [...alias.entries()].filter(([id]) => id !== seed.recordingId).map(([, old]) => old)
    const result = await suggestAutoplay({ userId: user.id, seeds: [alias.get(seed.recordingId)!], exclude: others, limit: WINDOW })
    expect(result).toEqual([])
  })

  it('starts an artist radio from a track the artist leads without credit rows', async () => {
    const user = await signIn()
    const artist = await createArtist({ name: 'Uncredited' })
    const album = await createAlbum({ artist, owned: true, tracks: [{ title: 'Only' }] })
    // Later radios can suggest this owned track (rarely: it shares no genre or era), and
    // they look every suggestion up in `tracks`.
    tracks.push({ recordingId: album.tracks[0]!.recordingId, albumId: album.albumId, artistId: artist.id, genre: 'None', owned: true })
    // Rows from older imports and catalog stubs can carry only the primary artist.
    await db.delete(recordingArtists).where(eq(recordingArtists.recordingId, album.tracks[0]!.recordingId))
    const response = await app.inject({ method: 'POST', url: `/api/v1/radio/artist/${artist.id}`, headers: user.headers })
    expect(body(response, RadioResponse).tracks[0]!.trackId).toBe(album.tracks[0]!.recordingId)
  })

  describe('similar artists', () => {
    let artist: { id: string; name: string }

    beforeAll(async () => {
      await updateServerSettings({ deezerEnabled: true, listenBrainzToken: 'operator-token' })
      artist = await shelf('Radiohead', 'Alternative', 1997, 1, { mbid: radiohead })
      await createArtist({ name: 'The Beatles', mbid: 'b10bbbfc-cf9e-42e0-be17-e2c3e1d2600d' })
      // Same name as an artist ListenBrainz names, but a different MBID: someone else.
      await createArtist({ name: 'Arcade Fire', mbid: '11111111-2222-4333-8444-555555555555' })
      await shelf('Jeff Buckley', 'Folk', 1994, 2)
      await shelf('Blur', 'Britpop', 2003, 2)
    })
    afterAll(async () => {
      await updateServerSettings({ deezerEnabled: false, listenBrainzToken: null })
    })

    it('maps Deezer and ListenBrainz answers to catalog artists', async () => {
      const similar = await similarArtists(artist.id)
      // Without a known Deezer id, the artist is found by name.
      expect(http.requests).toContain('GET https://api.deezer.com/search/artist?q=Radiohead&limit=5')
      // Blur is named by both sources; Jeff Buckley only by Deezer (its top answer), The Beatles
      // only by ListenBrainz (by MBID). Arcade Fire's MBID differs from ListenBrainz's.
      const names = similar.map((one) => one.name)
      expect(names[0]).toBe('Blur')
      expect(names).toEqual(expect.arrayContaining(['Jeff Buckley', 'The Beatles']))
      expect(names).not.toContain('Arcade Fire')
      expect(similar[0]!.score).toBeGreaterThan(similar[1]!.score)
      // Deezer's suggestions the catalog lacked are stubs now, with their page and picture,
      // so the rail of a big artist is not limited to what someone happened to search.
      const pumpkins = similar.find((one) => one.name === 'The Smashing Pumpkins')!
      const [stub] = await db.execute<{ image: string | null; deezer: string | null }>(sql`
        select a.image_asset_id as image, (select external_id from external_ids e where e.provider = 'deezer' and e.entity_type = 'artist' and e.entity_id = a.id) as deezer
        from artists a where a.id = ${pumpkins.artistId}`)
      expect(stub!.deezer).toBeTruthy()
      expect(stub!.image).toBeTruthy()
      // Asked again, the same rows answer.
      expect((await similarArtists(artist.id)).map((one) => one.artistId)).toEqual(similar.map((one) => one.artistId))
    })

    it('ranks tracks by similar artists first', async () => {
      const user = await createUser()
      const seedTrack = tracks.find((track) => track.artistId === artist.id)!
      const result = await suggest({ userId: user.id, seeds: [seedTrack.recordingId], exclude: [], limit: WINDOW }, { random: seeded(3) })
      const buckley = tracks.find((track) => track.genre === 'Folk')!.artistId
      expect(result.slice(0, 3).map((item) => byId(item.trackId).artistId)).toContain(buckley)
    })

    it('uses a known Deezer id, and skips a source that fails', async () => {
      // Deezer's radio of the artist, read by an earlier radio, linked its Deezer id by name
      // as search does. Deezer answers 500 for this one, so only ListenBrainz is left.
      await db.delete(externalIds).where(and(eq(externalIds.provider, 'deezer'), eq(externalIds.entityId, artist.id)))
      await db.insert(externalIds).values({ provider: 'deezer', entityType: 'artist', externalId: '400', entityId: artist.id })
      const names = (await similarArtists(artist.id)).map((one) => one.name)
      expect(http.requests).toContain('GET https://api.deezer.com/artist/400/related?limit=20')
      expect(http.requests.filter((request) => request.includes('/search/'))).toEqual([])
      expect(names).toContain('The Beatles')
      expect(names).not.toContain('Jeff Buckley')
    })
  })

  describe('routes', () => {
    it('starts a radio from a track', async () => {
      const user = await signIn()
      const response = body(await app.inject({ method: 'POST', url: `/api/v1/radio/track/${seed.recordingId}`, headers: user.headers }), RadioResponse)
      expect(response.context).toEqual({ type: 'radio', id: `track:${seed.recordingId}`, title: 'Rock A 1.1' })
      expect(response.tracks[0]).toEqual<QueueSeed>({ trackId: seed.recordingId, albumId: seed.albumId, durationMs: 180_000, state: 'ready' })
      expect(response.tracks.length).toBeGreaterThan(30)
      expect(response.tracks.length).toBeLessThanOrEqual(50)
      expect(new Set(response.tracks.map((item) => item.trackId)).size).toBe(response.tracks.length)
      expect(response.tracks.every((item) => byId(item.trackId).owned)).toBe(true)
    })

    it('starts a radio from an artist with one of its owned tracks', async () => {
      const user = await signIn()
      const response = body(await app.inject({ method: 'POST', url: `/api/v1/radio/artist/${seed.artistId}`, headers: user.headers }), RadioResponse)
      expect(response.context).toEqual({ type: 'radio', id: `artist:${seed.artistId}`, title: 'Rock A' })
      expect(byId(response.tracks[0]!.trackId)).toMatchObject({ artistId: seed.artistId, owned: true })
    })

    it('answers 404 for unknown ids and 409 when nothing can be played', async () => {
      const user = await signIn()
      const unknown = '01900000-0000-7000-8000-000000000000'
      expect(errorCode(await app.inject({ method: 'POST', url: `/api/v1/radio/track/${unknown}`, headers: user.headers }), 404)).toBe('not_found')
      expect(errorCode(await app.inject({ method: 'POST', url: `/api/v1/radio/artist/${unknown}`, headers: user.headers }), 404)).toBe('not_found')
      const unowned = tracks.find((track) => !track.owned)!
      expect(errorCode(await app.inject({ method: 'POST', url: `/api/v1/radio/track/${unowned.recordingId}`, headers: user.headers }), 409)).toBe('not_playable')
      const silent = await createArtist({ name: 'Nobody' })
      expect(errorCode(await app.inject({ method: 'POST', url: `/api/v1/radio/artist/${silent.id}`, headers: user.headers }), 409)).toBe('nothing_playable')
      expect((await app.inject({ method: 'POST', url: `/api/v1/radio/track/${seed.recordingId}` })).statusCode).toBe(401)
    })
  })
})
