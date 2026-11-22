/**
 * Radios judged the way a listener would, on a server like the test instance: a few
 * hundred files that are mostly whatever people played lately, a catalog that knows the
 * seed artists from search, and an acquisition provider that can fetch anything. Deezer's
 * answers are recorded (`src/test/http/deezer/`).
 *
 * The rows of each seed artist's Deezer radio are written before the radios start, and
 * the wait for outside sources is long: on a busy machine the first radio of an artist can
 * answer with part of them (see enrichment's radio.test.ts), which is not what is judged.
 *
 * Set SQUIRMY_RADIO_PRINT to a file path to have each radio written there.
 */
import { appendFileSync } from 'node:fs'
import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { db } from '../../database/client.js'
import { albums, externalIds, likes, recordingArtists } from '../../database/schema.js'
import { updateServerSettings } from '../../lib/settings.js'
import { createPlay } from '../../test/catalog.js'
import { useTestDatabase } from '../../test/database.js'
import { createAlbum, createArtist, createUser } from '../../test/factories.js'
import { useHttpFixtures } from '../../test/http.js'
import { artistRadioTracks } from '../enrichment/detail.js'
import { artistRadio, trackRadio } from './radio.js'

// The provider covers everything that is not on the server, as an `assume_available` one does.
vi.mock('../acquisition/coverage.js', () => ({
  onDemandRecordings: vi.fn(async (ids: readonly string[]) => new Set(ids)),
  albumCoveredWithoutTracks: vi.fn(async () => true),
  requestRecording: vi.fn(async () => {}),
}))

/** A small seeded generator (mulberry32), so a radio can be repeated. */
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

type Shelf = { name: string; genres: string[]; year: number; deezerId?: number; owned: string[]; known?: string[] }

/**
 * What the server holds (`owned`) and what the catalog knows without a file (`known`, from
 * search and artist pages). Genres and years as MusicBrainz has them.
 */
const shelves: Shelf[] = [
  { name: 'Khruangbin', genres: ['indie rock', 'psychedelic rock', 'surf', 'blues', 'dub'], year: 2020, deezerId: 5328540,
    owned: [], known: ['Maria También', 'White Gloves', 'Time (You and I)', 'So We Won\'t Forget', 'August 10', 'People Everywhere (Still Alive)', 'Mr. White', 'Evan Finds the Third Room'] },
  { name: 'Leon Bridges', genres: ['r&b', 'soul', 'neo soul'], year: 2015, owned: [], known: ['River', 'Coming Home'] },
  { name: 'Cocteau Twins', genres: ['dream pop', 'ethereal wave'], year: 1990, deezerId: 1041,
    owned: ['Heaven or Las Vegas', 'Cherry-coloured Funk', 'Iceblink Luck', 'Pearly-Dewdrops\' Drops', 'Lorelei', 'Cico Buff'] },
  { name: 'Slowdive', genres: ['shoegaze', 'dream pop'], year: 1993, owned: ['Alison', 'When the Sun Hits', 'Machine Gun'] },
  { name: 'Mazzy Star', genres: ['dream pop', 'neo-psychedelia'], year: 1993, owned: ['Fade Into You', 'Halah'] },
  { name: 'Portishead', genres: ['trip hop', 'downtempo'], year: 1994, deezerId: 1069,
    owned: ['Glory Box', 'Sour Times', 'Roads', 'Wandering Star', 'It\'s a Fire', 'Strangers'] },
  { name: 'Tate McRae', genres: ['pop', 'dance-pop'], year: 2023, deezerId: 13817211,
    owned: ['greedy', 'exes', 'you broke me first', 'she\'s all i wanna be', 'run for the hills'] },
  { name: 'Fcukers', genres: ['dance-punk', 'indie dance'], year: 2024, owned: ['Bon Bon', 'Lonely', 'Butterflies', 'Shake It Up'] },
  { name: 'Death Grips', genres: ['experimental hip hop', 'industrial hip hop'], year: 2012, owned: ['Get Got', 'Guillotine', 'Hacker', 'Double Helix'] },
  { name: 'Talk Talk', genres: ['art rock', 'art pop'], year: 1988, owned: ['Eden (Edit)', 'It\'s My Life', 'Life\'s What You Make It'] },
  { name: 'The Strokes', genres: ['indie rock', 'garage rock revival'], year: 2001, owned: ['Last Nite', 'Someday', 'Reptilia'] },
  { name: 'Tame Impala', genres: ['psychedelic rock', 'neo-psychedelia', 'psychedelic pop'], year: 2015, owned: ['Let It Happen', 'The Less I Know the Better', 'Eventually'] },
  { name: 'Aphex Twin', genres: ['idm', 'electronic'], year: 1992, owned: ['Avril 14th', 'Xtal', 'Windowlicker'] },
  { name: 'Björk', genres: ['art pop', 'electronic'], year: 1997, owned: ['Jóga', 'Hunter', 'Isobel'] },
  { name: 'Grimes', genres: ['art pop', 'electropop'], year: 2015, owned: ['Genesis', 'Oblivion', 'California'] },
]

type Line = { artist: string; title: string; state: string }

/** Long enough for any machine: the sources answer from fixtures. */
const wait = 60_000

describe('radio, as a listener hears it', () => {
  useTestDatabase()
  useHttpFixtures('deezer')
  const ids = new Map<string, string>()
  const artistIds = new Map<string, string>()
  let userId = ''

  beforeAll(async () => {
    await updateServerSettings({ deezerEnabled: true })
    for (const shelf of shelves) {
      const artist = await createArtist({ name: shelf.name })
      artistIds.set(shelf.name, artist.id)
      if (shelf.deezerId) {
        // An artist page visited earlier linked it, as search and enrichment do.
        await db.insert(externalIds).values({ provider: 'deezer', entityType: 'artist', externalId: String(shelf.deezerId), entityId: artist.id })
      }
      const titles = [...shelf.owned, ...(shelf.known ?? [])]
      const album = await createAlbum({
        artist, year: shelf.year, title: `${shelf.name} collected`,
        tracks: titles.map((title) => ({ title, durationMs: 200_000 })),
        owned: shelf.owned.map((_, index) => index),
      })
      await db.update(albums).set({ genres: shelf.genres }).where(sql`${albums.id} = ${album.albumId}`)
      for (const [index, track] of album.tracks.entries()) ids.set(`${shelf.name} - ${titles[index]}`, track.recordingId)
    }
    // "Texas Sun" is on the server, credited to Khruangbin and Leon Bridges.
    const texas = await createAlbum({ artist: { id: artistIds.get('Khruangbin')!, name: 'Khruangbin' }, year: 2020, title: 'Texas Sun', tracks: [{ title: 'Texas Sun', durationMs: 252_000 }], owned: true })
    await db.update(albums).set({ genres: shelves[0]!.genres }).where(sql`${albums.id} = ${texas.albumId}`)
    await db.insert(recordingArtists).values({ recordingId: texas.tracks[0]!.recordingId, position: 1, artistId: artistIds.get('Leon Bridges')!, creditedName: 'Leon Bridges' })
    ids.set('Khruangbin - Texas Sun', texas.tracks[0]!.recordingId)

    for (const shelf of shelves.filter((one) => one.deezerId)) await artistRadioTracks(artistIds.get(shelf.name)!)

    const user = await createUser({ role: 'admin' })
    userId = user.id
    // One afternoon of people testing the account: the seed, then whatever came next.
    for (const [minutes, track] of [[300, 'Khruangbin - Texas Sun'], [296, 'Portishead - Glory Box'], [292, 'Fcukers - Lonely'], [288, 'Death Grips - Get Got'],
      [284, 'Tate McRae - greedy'], [240, 'Khruangbin - Texas Sun'], [236, 'Portishead - Glory Box'], [232, 'Fcukers - Lonely']] as const) {
      await createPlay({ userId, recordingId: ids.get(track)!, minutesAgo: 24 * 60 + minutes })
    }
    // What the owner likes, in more than one genre.
    await db.insert(likes).values([
      { userId, entityType: 'artist', entityId: artistIds.get('Death Grips')! },
      { userId, entityType: 'recording', entityId: ids.get('Tate McRae - greedy')! },
      { userId, entityType: 'recording', entityId: ids.get('Slowdive - Alison')! },
    ])
  })
  afterAll(async () => {
    await updateServerSettings({ deezerEnabled: false })
  })

  async function lines(radio: { tracks: { trackId: string; state?: string }[] }): Promise<Line[]> {
    const rows = await db.execute<{ id: string; title: string; artist: string }>(sql`
      select r.id, r.title, coalesce(a.name, r.artist_credit) as artist from recordings r left join artists a on a.id = r.primary_artist_id
      where r.id = any(${`{${radio.tracks.map((track) => track.trackId).join(',')}}`}::uuid[])`)
    const byId = new Map(rows.map((row) => [row.id, row]))
    return radio.tracks.map((track) => ({ artist: byId.get(track.trackId)!.artist, title: byId.get(track.trackId)!.title, state: track.state ?? 'ready' }))
  }

  function print(name: string, radio: Line[]) {
    if (!process.env.SQUIRMY_RADIO_PRINT) return
    appendFileSync(process.env.SQUIRMY_RADIO_PRINT, `\n${name} (${radio.length} tracks)\n${radio.map((line, index) => `${String(index + 1).padStart(2)}. ${line.artist} - ${line.title}${line.state === 'ready' ? ' [on the server]' : ''}`).join('\n')}\n`)
  }

  /** Artists Deezer named for the seed artist: its radio and its related artists, as recorded. */
  async function namedByDeezer(): Promise<Set<string>> {
    const rows = await db.execute<{ name: string }>(sql`
      select a.name from artists a join external_ids e on e.entity_id = a.id and e.provider = 'deezer' and e.entity_type = 'artist'`)
    return new Set(rows.map((row) => row.name))
  }

  it('plays Khruangbin and artists like them after "Texas Sun", not what the server happens to hold', async () => {
    const radio = await lines(await trackRadio(userId, ids.get('Khruangbin - Texas Sun')!, { random: seeded(1), similarTimeoutMs: wait }))
    print('Track radio: Khruangbin - Texas Sun', radio)
    const rest = radio.slice(1)
    // Cached music in other genres, liked or played next to the seed on one afternoon.
    const unrelated = ['Tate McRae', 'Fcukers', 'Death Grips', 'Portishead', 'Talk Talk', 'Aphex Twin', 'Björk', 'Grimes', 'Cocteau Twins', 'Slowdive']
    expect(rest.filter((line) => unrelated.includes(line.artist))).toEqual([])
    const named = await namedByDeezer()
    const fitting = rest.filter((line) => line.artist === 'Khruangbin' || line.artist === 'Leon Bridges' || named.has(line.artist))
    expect(fitting.length / rest.length).toBeGreaterThanOrEqual(0.85)
    expect(new Set(rest.map((line) => line.artist)).size).toBeGreaterThanOrEqual(10)
    expect(rest.length).toBeGreaterThanOrEqual(25)
  })

  it('plays dream pop after Cocteau Twins, with the server\'s Slowdive and Mazzy Star early', async () => {
    const radio = await lines(await artistRadio(userId, artistIds.get('Cocteau Twins')!, { random: seeded(2), similarTimeoutMs: wait }))
    print('Artist radio: Cocteau Twins', radio)
    expect(radio[0]!.artist).toBe('Cocteau Twins')
    const unrelated = ['Tate McRae', 'Fcukers', 'Death Grips', 'Khruangbin', 'The Strokes', 'Aphex Twin']
    expect(radio.filter((line) => unrelated.includes(line.artist))).toEqual([])
    const early = radio.slice(1, 21).map((line) => line.artist)
    expect(early).toContain('Slowdive')
    expect(early).toContain('Mazzy Star')
  })

  it('plays trip hop after "Glory Box"', async () => {
    const radio = await lines(await trackRadio(userId, ids.get('Portishead - Glory Box')!, { random: seeded(3), similarTimeoutMs: wait }))
    print('Track radio: Portishead - Glory Box', radio)
    const unrelated = ['Tate McRae', 'Fcukers', 'Death Grips', 'Khruangbin', 'The Strokes', 'Tame Impala', 'Talk Talk']
    expect(radio.filter((line) => unrelated.includes(line.artist))).toEqual([])
    expect(radio.length).toBeGreaterThanOrEqual(20)
  })

  it('plays pop after "greedy"', async () => {
    const radio = await lines(await trackRadio(userId, ids.get('Tate McRae - greedy')!, { random: seeded(4), similarTimeoutMs: wait }))
    print('Track radio: Tate McRae - greedy', radio)
    const unrelated = ['Death Grips', 'Cocteau Twins', 'Slowdive', 'Portishead', 'Aphex Twin', 'Khruangbin', 'Talk Talk']
    expect(radio.filter((line) => unrelated.includes(line.artist))).toEqual([])
    expect(radio.length).toBeGreaterThanOrEqual(20)
  })
})
