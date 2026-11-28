import { HomeResponse, type HomeSection } from '@squirmy/contracts'
import { eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { buildApp } from '../../app.js'
import { db } from '../../database/client.js'
import { albums, collectionPlays, homePicks, plays, playlistItems, playlists } from '../../database/schema.js'
import { drainJobs, jobs, startJobs } from '../../jobs/index.js'
import { newId } from '../../lib/ids.js'
import { updateServerSettings } from '../../lib/settings.js'
import { body, signIn } from '../../test/api.js'
import { createAsset } from '../../test/catalog.js'
import { useTestDatabase } from '../../test/database.js'
import { createAlbum, createArtist } from '../../test/factories.js'
import { listMixes, saveMixes } from '../radio/index.js'
import { byTimeOfDay, daypartFit, daypartHours, fitOf } from './home.js'
import { homePicksDue } from './home-picks.js'
import { catalogModule } from './index.js'

const similar = vi.hoisted(() => ({ artists: [] as { artistId: string; name: string; score: number }[] }))
vi.mock('../radio/similar.js', () => ({ similarArtists: vi.fn(async () => similar.artists) }))
vi.mock('../acquisition/coverage.js', () => ({
  onDemandRecordings: vi.fn(async () => new Set<string>()),
  requestRecording: vi.fn(async () => {}),
}))
vi.mock('../../jobs/index.js', async (importOriginal) => ({ ...(await importOriginal<object>()), schedule: vi.fn(async () => {}) }))

const HOUR = 60 * 60_000
const DAY = 24 * HOUR

type Play = { userId: string; recordingId: string; albumId: string | null; at: number; context?: [string, string | null]; completed?: boolean; skipped?: boolean }
async function play({ userId, recordingId, albumId, at, context, completed = true, skipped = false }: Play) {
  await db.insert(plays).values({
    id: newId(), userId, recordingId, albumId, startedAt: new Date(Date.now() - at), msPlayed: skipped ? 2000 : 120_000,
    completed: completed && !skipped, skipped, contextType: context?.[0] ?? null, contextId: context?.[1] ?? null,
  })
}

/** An Etc zone whose local hour is `hour` now. Etc zones have no daylight saving time. */
function zoneAt(hour: number) {
  let offset = hour - new Date().getUTCHours()
  if (offset > 14) offset -= 24
  if (offset < -12) offset += 24
  // Etc/GMT signs are inverted: Etc/GMT-2 is two hours ahead of UTC.
  return offset === 0 ? 'Etc/GMT' : `Etc/GMT${offset > 0 ? '-' : '+'}${Math.abs(offset)}`
}

const ids = (sections: HomeSection[]) => sections.map((section) => section.id)
const section = <K extends HomeSection['kind']>(sections: HomeSection[], id: string, kind: K) => {
  const found = sections.find((one) => one.id === id)
  expect(found?.kind, id).toBe(kind)
  return found as Extract<HomeSection, { kind: K }>
}

describe('time of day', () => {
  it('tells the part of the day where the user is', () => {
    const at = new Date('2026-11-28T13:30:00Z')
    expect(daypartHours('UTC', at)).toContain(13)
    expect(daypartHours('Asia/Tokyo', at)).toContain(22)
    expect(daypartHours('America/New_York', at)).toContain(8)
    expect(daypartHours('Not/A_Zone', at)).toBeNull()
  })

  it('tells how much of each artist’s listening is at this part of the day where the user is', () => {
    const hours = (plays: Record<number, number>) => Array.from({ length: 24 }, (_, hour) => plays[hour] ?? 0)
    // 13:30 UTC is 08:30 in New York: morning there is 10:00 to 16:59 UTC.
    const hourly = { morning: hours({ 10: 8, 16: 12 }), mixed: hours({ 12: 6, 2: 6 }), night: hours({ 2: 30 }), rare: hours({ 11: 2 }) }
    const at = new Date('2026-11-28T13:30:00Z')
    expect(daypartFit(hourly, 'America/New_York', at)).toEqual(new Map([['morning', 1], ['mixed', 0.5], ['night', 0]]))
    // Late night in Tokyo (22:30) is 13:00 to 19:59 UTC.
    expect(daypartFit(hourly, 'Asia/Tokyo', at)?.get('morning')).toBe(0.6)
    // Too few plays at this part of the day to go by.
    expect(daypartFit({ night: hours({ 2: 30, 12: 2 }) }, 'America/New_York', at)).toBeNull()
  })

  it('fits a rail by the mean of its cards, leaving out what it cannot tell', () => {
    const fit = new Map([['a', 1], ['b', 0], ['c', 0.5]])
    expect(fitOf(fit, [['a'], ['b']])).toBe(0.5)
    expect(fitOf(fit, [['a', 'c'], ['unknown']])).toBe(0.75)
    expect(fitOf(fit, [['unknown']])).toBe(0)
  })

  it('moves items only by a clear difference, keeping their order otherwise', () => {
    const shares: Record<string, number> = { a: 0.1, b: 0.05, c: 0.6, d: 0.2 }
    expect(byTimeOfDay(['a', 'b', 'c', 'd'], (item) => shares[item]!)).toEqual(['c', 'd', 'a', 'b'])
    expect(byTimeOfDay(['a', 'b'], () => 0)).toEqual(['a', 'b'])
  })
})

describe('personal home', () => {
  useTestDatabase()
  let app: FastifyInstance

  async function shelf(name: string, genre: string) {
    const artist = await createArtist({ name })
    const album = await createAlbum({ artist, owned: true, title: `${name} LP`, tracks: Array.from({ length: 6 }, (_, n) => ({ title: `${name} ${n + 1}` })) })
    await db.update(albums).set({ genres: [genre], artworkAssetId: (await createAsset()).id }).where(eq(albums.id, album.albumId))
    return { artist, albumId: album.albumId, tracks: album.tracks.map((track) => ({ recordingId: track.recordingId, albumId: album.albumId })) }
  }

  const homeOf = async (user: { headers: Record<string, string> }, query = 'layout=personal') =>
    body(await app.inject({ url: `/api/v1/home?${query}`, headers: user.headers }), HomeResponse).sections

  beforeAll(async () => {
    await updateServerSettings({ deezerEnabled: false })
    app = await buildApp()
    await catalogModule.jobs!(jobs)
    await startJobs({ work: true })
  })
  afterAll(async () => {
    await app.close()
  })

  it('shows a new listener the server’s music, and the classic layout to older apps', async () => {
    await shelf('Opening Act', 'pop')
    const fresh = await signIn()
    expect(ids(await homeOf(fresh))).toEqual(['recently-added'])
    expect(ids(await homeOf(fresh, ''))).toEqual(['recently-added'])
    // Nothing played: no run is due, so none is queued.
    expect(await homePicksDue(fresh.id, undefined, 0)).toBe(false)
  })

  it('jumps back into the places played from, newest first, each once', async () => {
    const user = await signIn()
    const other = await signIn()
    const [a, b, c, d] = [await shelf('Place A', 'rock'), await shelf('Place B', 'rock'), await shelf('Place C', 'rock'), await shelf('Place D', 'rock')]
    const mine = newId()
    const theirs = newId()
    await db.insert(playlists).values([{ id: mine, ownerId: user.id, name: 'Mine' }, { id: theirs, ownerId: other.id, name: 'Private' }])
    await db.insert(playlistItems).values({ id: newId(), playlistId: mine, position: 0, ...b.tracks[0]! })
    await saveMixes(user.id, [{ label: 'Rock', artistIds: [a.artist.id], tracks: a.tracks.map((track) => ({ id: track.recordingId, albumId: track.albumId, durationMs: 1000 })) }])
    const [mix] = await listMixes(user.id)
    const u = user.id
    await play({ userId: u, ...a.tracks[0]!, at: 50 * 60_000, context: ['album', a.albumId] })
    await play({ userId: u, ...a.tracks[1]!, at: 48 * 60_000, context: ['album', a.albumId] })
    await play({ userId: u, ...b.tracks[0]!, at: 40 * 60_000, context: ['playlist', mine] })
    await play({ userId: u, ...b.tracks[1]!, at: 35 * 60_000, context: ['playlist', theirs] })
    await play({ userId: u, ...c.tracks[0]!, at: 30 * 60_000, context: ['radio', `artist:${c.artist.id}`] })
    // A radio's songs are the radio's, not their albums'.
    await play({ userId: u, ...d.tracks[0]!, at: 29 * 60_000, context: ['radio', `artist:${c.artist.id}`] })
    await play({ userId: u, ...a.tracks[2]!, at: 20 * 60_000, context: ['mix', mix!.mix.id] })
    await play({ userId: u, ...b.tracks[2]!, at: 10 * 60_000, context: ['search', null] })
    await play({ userId: u, ...a.tracks[3]!, at: 5 * 60_000, context: ['liked', null] })
    // An early skip is not a place played from.
    await play({ userId: u, ...d.tracks[1]!, at: 60_000, skipped: true, context: ['album', d.albumId] })
    // Adding an album to the library counts as playing it, as in the Library.
    await db.insert(collectionPlays).values({ userId: u, entityType: 'album', entityId: c.albumId, playedAt: new Date(Date.now() - 2 * 60_000) })

    const jump = section(await homeOf(user), 'jump-back-in', 'items')
    expect(jump.title).toBe('Jump back in')
    expect(jump.items.map((item) => {
      switch (item.kind) {
        case 'album': return `album ${item.album.title}`
        case 'artist': return `artist ${item.artist.name}`
        case 'playlist': return `playlist ${item.playlist.name}`
        case 'liked': return 'liked'
        case 'mix': return `mix ${item.mix.name}`
        case 'radio': return `radio ${item.radio.seed} ${item.radio.title}`
      }
    })).toEqual(['album Place C LP', 'liked', 'album Place B LP', 'mix Mix 1 · Rock', 'radio artist Place C', 'playlist Mine', 'album Place A LP'])
  })

  it('makes the day’s picks in the background, then shows them', async () => {
    const user = await signIn()
    const folk = [await shelf('Folk One', 'folk'), await shelf('Folk Two', 'folk')]
    const techno = [await shelf('Techno One', 'techno'), await shelf('Techno Two', 'techno')]
    const like = [await shelf('Like One', 'folk'), await shelf('Like Two', 'folk'), await shelf('Like Three', 'folk')]
    similar.artists = [...like.map((one, index) => ({ artistId: one.artist.id, name: one.artist.name, score: 1 - index / 10 })), { artistId: newId(), name: 'Gone', score: 0.1 }]
    const u = user.id
    // Folk an hour before this time of day, techno an hour after it. Where it is 11:00 now,
    // folk is the morning's listening (10:00) and techno the afternoon's (12:00); where it is
    // 05:00, folk is the night's (04:00) and techno the morning's (06:00). Techno is played more.
    const folkHour = zoneAt(11)
    const technoHour = zoneAt(5)
    for (let day = 1; day <= 6; day++) {
      for (const one of folk) await play({ userId: u, ...one.tracks[day % 6]!, at: day * DAY + HOUR })
      for (const one of techno) for (const track of one.tracks.slice(0, 2)) await play({ userId: u, ...track, at: day * DAY - HOUR })
    }
    // Played a lot eight months ago and not since: rediscovered. Played since, or too long ago: not.
    const forgotten = await shelf('Forgotten', 'jazz')
    for (let n = 0; n < 3; n++) {
      await play({ userId: u, ...forgotten.tracks[0]!, at: 240 * DAY + n * HOUR })
      await play({ userId: u, ...forgotten.tracks[1]!, at: 240 * DAY + n * HOUR })
      await play({ userId: u, ...forgotten.tracks[2]!, at: 900 * DAY + n * HOUR })
    }
    await play({ userId: u, ...forgotten.tracks[1]!, at: 3 * DAY })

    // The first Home has no picks yet and queues their run.
    const first = await homeOf(user, `layout=personal&tz=${folkHour}`)
    expect(ids(first)).not.toContain('made-for-you')
    await drainJobs()
    const [picks] = await db.select().from(homePicks).where(eq(homePicks.userId, u))
    expect(picks).toBeDefined()
    expect(await homePicksDue(u, picks, 2)).toBe(false)

    const folkTime = await homeOf(user, `layout=personal&tz=${folkHour}`)
    const made = section(folkTime, 'made-for-you', 'items')
    expect(made.items.map((item) => item.kind === 'mix' && item.mix.name)).toEqual(['Mix 2 · Folk', 'Mix 1 · Techno'])
    expect(section(folkTime, 'because-you-listened', 'artists')).toMatchObject({
      title: expect.stringMatching(/^Because you listened to (Folk|Techno) (One|Two)$/),
      artists: like.map((one) => ({ id: one.artist.id })),
    })
    // This month's: Forgotten's song played three days ago counts too.
    expect(section(folkTime, 'top-artists', 'artists').artists.map((artist) => artist.name)).toHaveLength(5)
    expect(section(folkTime, 'rediscover', 'tracks').tracks.map((track) => track.id)).toEqual([forgotten.tracks[0]!.recordingId])
    // Rails go by how well they fit this part of the day; Jump back in stays on top. Most played
    // is mostly folk, so it leads where folk is this hour's music and follows the mixes where
    // techno is.
    expect(ids(folkTime)[0]).toBe('jump-back-in')
    expect(ids(folkTime).indexOf('most-played')).toBeLessThan(ids(folkTime).indexOf('made-for-you'))

    const technoTime = await homeOf(user, `layout=personal&tz=${technoHour}`)
    expect(section(technoTime, 'made-for-you', 'items').items.map((item) => item.kind === 'mix' && item.mix.name)).toEqual(['Mix 1 · Techno', 'Mix 2 · Folk'])
    expect(ids(technoTime).indexOf('made-for-you')).toBeLessThan(ids(technoTime).indexOf('most-played'))
    // Without a time zone the mixes keep their slots' order.
    expect(section(await homeOf(user), 'made-for-you', 'items').items.map((item) => item.kind === 'mix' && item.mix.name)).toEqual(['Mix 1 · Techno', 'Mix 2 · Folk'])
  })
})
