import { MixDetail, type TrackSummary } from '@squirmy/contracts'
import { eq, sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { buildApp } from '../../app.js'
import { db } from '../../database/client.js'
import { albums, mixes, sonicAnalyses } from '../../database/schema.js'
import { newId } from '../../lib/ids.js'
import { updateServerSettings } from '../../lib/settings.js'
import { body, errorCode, signIn } from '../../test/api.js'
import { createAsset, createPlay } from '../../test/catalog.js'
import { useTestDatabase } from '../../test/database.js'
import { createAlbum, createArtist } from '../../test/factories.js'
import { VECTOR_LENGTH } from '../sonic/dsp/analyzer.js'
import type { SonicPoint } from '../sonic/index.js'
import { resetSonicIndex } from '../sonic/vectors.js'
import { artistLine, cluster, genreLabel, interleave, listMixes, makeMixes, saveMixes, sequenceCost, smoothOrder } from './mixes.js'
import { artistSoundAffinity, pairKey } from './sonic.js'

vi.mock('../acquisition/coverage.js', () => ({
  onDemandRecordings: vi.fn(async () => new Set<string>()),
  requestRecording: vi.fn(async () => {}),
}))

const artist = (id: string, plays: number, genres: Record<string, number>) =>
  ({ id, name: id.toUpperCase(), plays, sessions: 1, score: plays, genres: new Map(Object.entries(genres)) })
const noSignals = { similar: new Map<string, number>(), together: new Map<string, number>(), sound: null }

describe('mix rules', () => {
  it('names genres as people write them', () => {
    expect(genreLabel('indie folk')).toBe('Indie Folk')
    expect(genreLabel('r&b')).toBe('R&B')
    expect(genreLabel('lo-fi hip hop')).toBe('Lo-Fi Hip Hop')
    expect(genreLabel('drum and bass')).toBe('Drum and Bass')
  })

  it('lists a few artists and says when there are more', () => {
    expect(artistLine(['A'])).toBe('A')
    expect(artistLine(['A', 'B'])).toBe('A and B')
    expect(artistLine(['A', 'B', 'C'])).toBe('A, B and C')
    expect(artistLine(['A', 'B', 'C', 'D'])).toBe('A, B, C and more')
  })

  it('clusters artists that share genres or similar-artist data, most played first', () => {
    const artists = [
      artist('folk1', 30, { folk: 1 }), artist('techno1', 25, { techno: 1 }), artist('folk2', 20, { folk: 1, 'indie folk': 1 }),
      artist('techno2', 15, { techno: 1 }), artist('loner', 5, { polka: 1 }), artist('nogenre', 8, {}),
    ]
    expect(cluster(artists, noSignals).map((members) => members.map((member) => member.id))).toEqual([['folk1', 'folk2'], ['techno1', 'techno2']])
    // Similar-artist data alone links an artist without genres, and so does being played in
    // the same sittings again and again; now and then is not enough.
    const similar = new Map([[pairKey('techno1', 'nogenre'), 0.9]])
    const together = new Map([[pairKey('folk1', 'loner'), 0.3], [pairKey('folk2', 'loner'), 0.3]])
    expect(cluster(artists, { similar, together, sound: null }).map((members) => members.map((member) => member.id)))
      .toEqual([['folk1', 'folk2'], ['techno1', 'techno2', 'nogenre']])
    const often = new Map([[pairKey('folk1', 'loner'), 0.9], [pairKey('folk2', 'loner'), 0.9]])
    expect(cluster(artists, { ...noSignals, together: often })[0]!.map((member) => member.id)).toEqual(['folk1', 'folk2', 'loner'])
    // The sound seam can link artists too, once it answers.
    const sound = new Map([[pairKey('folk1', 'loner'), 0.9]])
    expect(cluster(artists, { ...noSignals, sound })[0]!.map((member) => member.id)).toEqual(['folk1', 'folk2', 'loner'])
  })

  it('opens on a favourite, returns to them every third song, and avoids an artist twice in a row', () => {
    const track = (id: string, artistId: string) => ({ id, artists: [{ id: artistId, name: artistId }], artistCredit: artistId }) as TrackSummary
    const loved = [track('l1', 'a'), track('l2', 'a'), track('l3', 'b')]
    const fresh = [track('f1', 'a'), track('f2', 'c'), track('f3', 'd'), track('f4', 'e')]
    expect(interleave(loved, fresh, 50).map((one) => one.id)).toEqual(['l1', 'f2', 'f1', 'l3', 'f3', 'f4', 'l2'])
    expect(interleave(loved, fresh, 3)).toHaveLength(3)
  })

  describe('smooth order', () => {
    const track = (id: string, artistId: string) => ({ id, artists: [{ id: artistId, name: artistId }], artistCredit: artistId }) as TrackSummary
    const point = (id: string, bpm: number, energy: number, tonic = 0): SonicPoint => ({
      recordingId: id, analyzed: true, bpm, bpmSource: 'analysis', bpmConfidence: 0.9, key: { tonic, mode: 'major' }, keySource: 'analysis',
      keyConfidence: 0.9, energy, danceability: 0.5, moods: [],
    })
    // Two tempos and energies, alternating as `interleave` laid them out: every step a jump.
    const loved = Array.from({ length: 6 }, (_, n) => track(`l${n}`, `a${n}`))
    const fresh = Array.from({ length: 12 }, (_, n) => track(`f${n}`, `b${n}`))
    const mixed = interleave(loved, fresh, 50)
    const points = new Map(mixed.map((one, n) => [one.id, n % 2 ? point(one.id, 90, 0.2, 6) : point(one.id, 128, 0.9)]))
    const favourites = new Set(loved.map((one) => one.id))

    it('lowers the cost of the transitions, keeping the mix in shape', () => {
      const ordered = smoothOrder(mixed, favourites, points)
      const ids = (list: TrackSummary[]) => list.map((one) => one.id)
      expect(sequenceCost(ids(mixed), points)).toBeGreaterThan(0)
      expect(sequenceCost(ids(ordered), points)).toBeLessThan(sequenceCost(ids(mixed), points) / 2)
      expect(ids(ordered).toSorted()).toEqual(ids(mixed).toSorted())
      // The same opening, and favourites where favourites were.
      expect(ordered[0]).toBe(mixed[0])
      expect(ordered.map((one) => favourites.has(one.id))).toEqual(mixed.map((one) => favourites.has(one.id)))
      // The same day, the same order.
      expect(ids(smoothOrder(mixed, favourites, points))).toEqual(ids(ordered))
    })

    it('changes nothing without analysis, and never puts an artist twice in a row to save a jump', () => {
      expect(smoothOrder(mixed, favourites, new Map())).toEqual(mixed)
      // One artist for the suggestions that sound like the opening favourite: they stay apart.
      const sameArtist = mixed.map((one) => (favourites.has(one.id) ? one : track(one.id, points.get(one.id)!.bpm === 128 ? 'x' : one.artists[0]!.id)))
      const repeats = (list: TrackSummary[]) => list.filter((one, n) => n > 0 && one.artists[0]!.id === list[n - 1]!.artists[0]!.id).length
      expect(repeats(sameArtist)).toBe(0)
      expect(repeats(smoothOrder(sameArtist, favourites, points))).toBe(0)
    })
  })
})

describe('mixes', () => {
  useTestDatabase()
  let app: FastifyInstance

  /** An artist of the genre with two owned albums of four songs. */
  async function shelf(name: string, genre: string) {
    const made = await createArtist({ name })
    const tracks: { recordingId: string; albumId: string }[] = []
    for (const index of [1, 2]) {
      const album = await createAlbum({ artist: made, owned: true, title: `${name} ${index}`, tracks: Array.from({ length: 4 }, (_, n) => ({ title: `${name} ${index}.${n + 1}` })) })
      await db.update(albums).set({ genres: [genre], artworkAssetId: (await createAsset()).id }).where(eq(albums.id, album.albumId))
      tracks.push(...album.tracks.map((one) => ({ recordingId: one.recordingId, albumId: album.albumId })))
    }
    return { artist: made, tracks }
  }

  beforeAll(async () => {
    // No outside similar-artist data: mixes come from genres and listening alone.
    await updateServerSettings({ deezerEnabled: false })
    app = await buildApp()
  })
  afterAll(async () => {
    await app.close()
  })

  it('makes one mix per taste, the same all day, each song in one mix only', async () => {
    const user = await signIn()
    // Folk C is tagged plain folk: the word and the sittings it shares with the others bring it in.
    const folk = [await shelf('Folk A', 'indie folk'), await shelf('Folk B', 'indie folk'), await shelf('Folk C', 'folk')]
    const techno = [await shelf('Techno A', 'techno'), await shelf('Techno B', 'techno')]
    // Never played, and nothing like either taste: radio may pad with it, a mix does not.
    const jazz = await shelf('Jazz A', 'jazz')
    // Played a lot lately: folk most.
    for (const [index, one] of folk.entries()) {
      for (const [n, track] of one.tracks.slice(0, 4).entries()) {
        for (let play = 0; play < 3 - index % 2; play++) await createPlay({ userId: user.id, ...track, minutesAgo: 60 * (n + play * 24) })
      }
    }
    for (const one of techno) for (const track of one.tracks.slice(0, 3)) await createPlay({ userId: user.id, ...track, minutesAgo: 600 })

    const made = await makeMixes(user.id, '2026-11-28')
    expect(made.map((mix) => mix.label)).toEqual(['Indie Folk, Folk', 'Techno'])
    expect(made[0]!.artistIds.toSorted()).toEqual(folk.map((one) => one.artist.id).toSorted())
    expect(made[1]!.artistIds.toSorted()).toEqual(techno.map((one) => one.artist.id).toSorted())
    for (const mix of made) expect(mix.tracks.length).toBeGreaterThanOrEqual(10)
    // It opens on the most played favourite of its artists.
    expect(folk.flatMap((one) => one.tracks.map((track) => track.recordingId))).toContain(made[0]!.tracks[0]!.id)
    const all = made.flatMap((mix) => mix.tracks.map((track) => track.id))
    expect(new Set(all).size).toBe(all.length)
    expect(all.filter((id) => jazz.tracks.some((track) => track.recordingId === id))).toEqual([])
    expect(await makeMixes(user.id, '2026-11-28')).toEqual(made)

    await saveMixes(user.id, made)
    const listed = await listMixes(user.id)
    expect(listed.map((one) => one.mix.name)).toEqual(['Mix 1 · Indie Folk, Folk', 'Mix 2 · Techno'])
    expect(listed[0]!.mix).toMatchObject({ trackCount: made[0]!.tracks.length, description: expect.stringMatching(/^Folk [ABC], Folk [ABC] and Folk [ABC]$/) })
    // A cover of each of its first four albums.
    expect(listed[0]!.mix.artworks).toHaveLength(4)

    const detail = body(await app.inject({ url: `/api/v1/mixes/${listed[1]!.mix.id}`, headers: user.headers }), MixDetail)
    expect(detail.tracks.map((track) => track.id)).toEqual(made[1]!.tracks.map((track) => track.id))
    expect(detail.tracks.every((track) => track.availability === 'server')).toBe(true)

    // Someone else's mix, or none, is not found.
    const other = await signIn()
    expect(errorCode(await app.inject({ url: `/api/v1/mixes/${listed[1]!.mix.id}`, headers: other.headers }), 404)).toBe('not_found')
    expect(errorCode(await app.inject({ url: `/api/v1/mixes/${newId()}`, headers: user.headers }), 404)).toBe('not_found')

    // Made again, a slot keeps its id; a slot no longer made is gone.
    await saveMixes(user.id, made.slice(0, 1))
    const again = await db.select().from(mixes).where(eq(mixes.userId, user.id))
    expect(again.map((row) => row.id)).toEqual([listed[0]!.mix.id])
  })

  it('makes mixes of artists that sound alike when nothing says their genres', async () => {
    const user = await signIn()
    // Two sounds far apart, each with a little spread; no genres, no similar-artist data.
    const vector = (base: number, jitter: number) => Array.from({ length: VECTOR_LENGTH }, (_, d) => base * (d % 2 ? 1 : -1) + Math.sin(d * 7 + jitter) * 0.2)
    async function sounding(name: string, base: number, seed: number) {
      const made = await shelf(name, '')
      await db.update(albums).set({ genres: [] }).where(eq(albums.primaryArtistId, made.artist.id))
      for (const [n, track] of made.tracks.entries()) {
        const [file] = await db.execute<{ id: string }>(sql`select id from media_files where recording_id = ${track.recordingId}`)
        await db.insert(sonicAnalyses).values({
          fileId: file!.id, version: 1, bpm: base > 0 ? 124 + (n % 3) * 10 : 80 + (n % 3) * 9, bpmConfidence: 0.9, key: (n * 5) % 12, mode: 'major',
          keyStrength: 0.8, energy: base > 0 ? 0.6 + (n % 4) * 0.1 : 0.15 + (n % 2) * 0.3, vector: vector(base, seed * 10 + n),
        })
      }
      return made
    }
    const loud = [await sounding('Loud A', 3, 1), await sounding('Loud B', 3, 2), await sounding('Loud C', 3, 3)]
    const soft = [await sounding('Soft A', -3, 4), await sounding('Soft B', -3, 5)]
    resetSonicIndex()
    // Each artist in sittings of its own, so playing together links nobody.
    for (const [k, one] of [...loud, ...soft].entries()) {
      for (const [n, track] of one.tracks.slice(0, 4).entries()) {
        for (let play = 0; play < 3; play++) await createPlay({ userId: user.id, ...track, minutesAgo: 60 * (k * 20 + n * 4 + play) + 5 })
      }
    }
    const sound = (await artistSoundAffinity([...loud, ...soft].map((one) => one.artist.id)))!
    expect(sound.get(pairKey(loud[0]!.artist.id, loud[1]!.artist.id))).toBeGreaterThan(0.8)
    expect(sound.get(pairKey(soft[0]!.artist.id, soft[1]!.artist.id))).toBeGreaterThan(0.8)
    expect(sound.get(pairKey(loud[0]!.artist.id, soft[0]!.artist.id))).toBe(0)

    const made = await makeMixes(user.id, '2026-11-28')
    expect(made.map((mix) => mix.artistIds.toSorted())).toEqual([loud.map((one) => one.artist.id).toSorted(), soft.map((one) => one.artist.id).toSorted()])
    // Each mix keeps to its sound: the suggestions too.
    const of = (group: typeof loud) => new Set(group.flatMap((one) => one.tracks.map((track) => track.recordingId)))
    expect(made[0]!.tracks.every((track) => of(loud).has(track.id))).toBe(true)
    expect(made[1]!.tracks.every((track) => of(soft).has(track.id))).toBe(true)
    expect(await makeMixes(user.id, '2026-11-28')).toEqual(made)
  })

  it('makes no mix without enough listening', async () => {
    const user = await signIn()
    const one = await shelf('Rare', 'jazz')
    await createPlay({ userId: user.id, ...one.tracks[0]!, minutesAgo: 5 })
    // An early skip or an unfinished play is not listening.
    await createPlay({ userId: user.id, ...one.tracks[1]!, minutesAgo: 5, completed: false })
    expect(await makeMixes(user.id, '2026-11-28')).toEqual([])
  })
})
