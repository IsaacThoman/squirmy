import { HistoryExportEntry, HistoryImport, HistoryImports, ReplayStats, type HistoryImportSource } from '@squirmy/contracts'
import { eq, sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from '../../app.js'
import { db } from '../../database/client.js'
import { albums, plays, recordingArtists } from '../../database/schema.js'
import { drainJobs, jobs, startJobs } from '../../jobs/index.js'
import { newId } from '../../lib/ids.js'
import { body, errorCode, signIn } from '../../test/api.js'
import { useTestDatabase } from '../../test/database.js'
import { createAlbum, createArtist } from '../../test/factories.js'
import { userdataModule } from './index.js'

describe('Replay and history transfers', () => {
  useTestDatabase()
  let app: FastifyInstance
  let owner: Awaited<ReturnType<typeof signIn>>
  let other: Awaited<ReturnType<typeof signIn>>
  const read = (url: string, who = owner) => app.inject({ url: `/api/v1/me/${url}`, headers: who.headers })
  const replay = async (query: string, who = owner) => body(await read(`replay?${query}`, who), ReplayStats)

  async function upload(source: HistoryImportSource, file: string, data: string) {
    const form = new FormData()
    form.append('file', new Blob([data]), file)
    const request = new Response(form)
    const response = await app.inject({
      method: 'POST', url: `/api/v1/me/history/imports?source=${source}`,
      headers: { ...owner.headers, 'content-type': request.headers.get('content-type')! },
      payload: Buffer.from(await request.arrayBuffer()),
    })
    return body(response, HistoryImport, 202)
  }

  beforeAll(async () => {
    await userdataModule.jobs!(jobs)
    await startJobs({ work: true })
    app = await buildApp()
    owner = await signIn({ username: 'replay-owner' })
    other = await signIn({ username: 'replay-other' })
  })
  afterAll(async () => { await app?.close() })

  it('uses local dates for years, previous periods, streaks and the clock, including daylight saving', async () => {
    const album = await createAlbum({ title: 'Evening signals' })
    const collaborator = await createArtist({ name: 'Guest' })
    const recordingId = album.tracks[0]!.recordingId
    await db.update(albums).set({ genres: ['Dream Pop', 'dream pop'] }).where(eq(albums.id, album.albumId))
    await db.insert(recordingArtists).values({ recordingId, artistId: collaborator.id, creditedName: collaborator.name, position: 1 })
    const insert = (userId: string, startedAt: string, msPlayed: number, skipped = false) => ({
      id: newId(), userId, startedAt: new Date(startedAt), albumId: album.albumId, recordingId, msPlayed, skipped,
    })
    await db.insert(plays).values([
      insert(owner.id, '2024-01-01T07:30:00Z', 70_000), // Dec 31 in Los Angeles
      insert(owner.id, '2024-01-01T08:30:00Z', 90_000),
      insert(owner.id, '2024-03-10T09:30:00Z', 90_000), // 01:30 PST
      insert(owner.id, '2024-03-10T10:30:00Z', 90_000), // 03:30 PDT
      insert(owner.id, '2024-12-31T20:30:00Z', 90_000),
      insert(owner.id, '2025-01-01T07:30:00Z', 90_000), // same local day as above
      insert(owner.id, '2024-12-30T20:30:00Z', 1_000, true),
      insert(other.id, '2024-12-30T20:30:00Z', 80_000),
    ])
    const result = await replay('period=review&year=2024&tz=America%2FLos_Angeles')
    expect(result.window).toEqual({ start: '2024-01-01T08:00:00.000Z', end: '2025-01-01T08:00:00.000Z' })
    expect(result.totals).toEqual({ plays: 5, msPlayed: 450_000, tracks: 1, albums: 1, artists: 2 })
    expect(result.previous).toMatchObject({ plays: 1, msPlayed: 70_000 })
    expect(result.clock).toEqual(expect.arrayContaining([
      { weekday: 7, hour: 1, plays: 1, msPlayed: 90_000 },
      { weekday: 7, hour: 3, plays: 1, msPlayed: 90_000 },
    ]))
    expect(result.tracks[0]).toMatchObject({ id: recordingId, track: { id: recordingId }, plays: 5 })
    expect(result.artists.map(artist => artist.plays)).toEqual([5, 5])
    expect(result.albums[0]).toMatchObject({ album: { id: album.albumId }, plays: 5 })
    expect(result.genres).toEqual([expect.objectContaining({ key: 'dream pop', plays: 5, msPlayed: 450_000 })])
    expect(result.streak).toEqual({ current: 1, longest: 1 })
    expect(result.discoveries).toEqual({ count: 0, artists: [] })
    const all = await replay('period=all')
    expect(all.firstYear).toBe(2024)
    expect(all.previous).toBeNull()
    expect(all.discoveries.count).toBe(2)
    expect((await replay('period=review&year=2024', other)).totals.plays).toBe(1)
    expect(errorCode(await read('replay?period=review'), 400)).toBeDefined()
    expect(errorCode(await read('replay?tz=Not%2FAZone'), 400)).toBeDefined()
    expect(errorCode(await read('replay?period=review&year=9998'), 400)).toBe('invalid_review_year')
    for (const period of ['week', 'month', 'year']) {
      const current = await replay(`period=${period}`)
      expect(current.window.start).toBe(current.previous?.end)
    }
  })

  it('queues each format, disambiguates by album, deduplicates, and exports unmatched listens and skips privately', async () => {
    const artist = await createArtist({ name: 'Beyoncé' })
    const track = { title: 'Somewhere, "Again"', durationMs: 180_000 }
    const exact = await createAlbum({ artist, title: 'Overnight', tracks: [track] })
    await createAlbum({ artist, title: 'Live', tracks: [track] })
    const listen = (artist: string, name: string, timestamp: string) => ({
      listened_at: Date.parse(timestamp) / 1000,
      track_metadata: { artist_name: artist, track_name: name, release_name: 'Overnight' },
    })
    const first = listen('Beyonce', track.title, '2021-05-03T05:00:00Z')
    const second = listen('=Uncatalogued', 'With a\nline break', '2021-05-04T05:00:00Z')
    const before = await db.execute<{ count: number }>(sql`select count(*)::int from recordings`)
    const lb = await upload('listenbrainz', 'listens.json', JSON.stringify({ payload: { listens: [first, second, false] } }))
    const repeat = await upload('listenbrainz', '2021-05.jsonl', `${JSON.stringify(first)}\n${JSON.stringify(second)}\n`)
    const lbArray = await upload('listenbrainz', 'listens-array.json', JSON.stringify([first, second]))
    const csv = await upload('lastfm', 'scrobbles.csv', 'Timestamp,Artist,Track,Album\r\n"05 May 2021, 05:00","Beyonce","Somewhere, ""Again""","Overnight"\r\n')
    const spotify = await upload('spotify', 'endsong_0.json', JSON.stringify([{
      ts: '2021-05-06T05:00:04Z', ms_played: 4000, spotify_track_uri: 'spotify:track:123',
      master_metadata_track_name: track.title, master_metadata_album_artist_name: 'Beyonce', master_metadata_album_album_name: 'Overnight',
    }, { ts: '2021-05-08T00:00:00Z', ms_played: 500_000, episode_name: 'Podcast' }]))
    await drainJobs()

    const jobsById = new Map(body(await read('history/imports'), HistoryImports).items.map(job => [job.id, job]))
    expect(jobsById.get(lb.id)).toMatchObject({ status: 'completed', processed: 3, matched: 1, unmatched: 1, ignored: 1 })
    expect(jobsById.get(repeat.id)).toMatchObject({ status: 'completed', processed: 2, duplicates: 2 })
    expect(jobsById.get(lbArray.id)).toMatchObject({ status: 'completed', processed: 2, duplicates: 2 })
    expect(jobsById.get(csv.id)).toMatchObject({ status: 'completed', matched: 1 })
    expect(jobsById.get(spotify.id)).toMatchObject({ status: 'completed', matched: 1, ignored: 1 })
    expect(body(await read('history/imports', other), HistoryImports).items).toEqual([])
    expect(await db.execute(sql`select count(*)::int from recordings`)).toEqual(before)

    const result = await replay('period=review&year=2021')
    expect(result.totals).toEqual({ plays: 3, tracks: 2, artists: 2, albums: 2, msPlayed: 360_000 })
    expect(result.streak.longest).toBe(3)
    expect(result.tracks[0]).toMatchObject({ id: exact.tracks[0]!.recordingId, plays: 2, msPlayed: 360_000 })
    expect(result.tracks[1]).toMatchObject({ id: null, name: 'With a\nline break' })

    const json = await read('history/export?format=json')
    expect(json.headers['content-disposition']).toBe('attachment; filename="squirmy-history.json"')
    expect(HistoryExportEntry.array().parse(json.json())).toEqual(expect.arrayContaining([
      expect.objectContaining({ title: track.title, source: 'lastfm', albumId: exact.albumId, completed: true, skipped: false }),
      expect.objectContaining({ title: track.title, source: 'spotify', startedAt: '2021-05-06T05:00:00.000Z', msPlayed: 4000, skipped: true }),
      expect.objectContaining({ artist: '=Uncatalogued', source: 'listenbrainz', recordingId: null, msPlayed: null }),
    ]))
    expect((await read('history/export?format=csv')).body).toContain(`"With a\nline break","'=Uncatalogued"`)
    expect((await read('history/export?format=json', other)).json()).not.toEqual(expect.arrayContaining([expect.objectContaining({ source: 'spotify' })]))
    expect((await app.inject({ url: '/api/v1/me/history/export' })).statusCode).toBe(401)
  })

  it('uses earlier unmatched listens for discoveries and keeps a matched listen’s unknown album', async () => {
    const artist = await createArtist({ name: 'June Avenue' })
    await createAlbum({ artist, title: 'First Edition', tracks: [{ title: 'Red Window' }] })
    const entry = (title: string, album: string, instant: string) => ({
      listened_at: Date.parse(instant) / 1000,
      track_metadata: { track_name: title, artist_name: artist.name, release_name: album },
    })
    await upload('listenbrainz', 'listens.json', JSON.stringify([
      entry('Unreleased Demo', 'Live Demos', '2019-01-01T08:00:00Z'),
      entry('Red Window', 'Expanded Edition', '2020-01-01T08:00:00Z'),
    ]))
    await drainJobs()

    const early = await replay('period=review&year=2019')
    expect(early.discoveries.artists).toEqual([expect.objectContaining({ id: artist.id, name: artist.name })])
    const later = await replay('period=review&year=2020')
    expect(later.discoveries.count).toBe(0)
    expect(later.albums).toEqual([expect.objectContaining({ id: null, name: 'Expanded Edition', plays: 1 })])
    expect((await replay('period=all')).artists).toContainEqual(expect.objectContaining({ id: artist.id, plays: 2 }))
  })

  it('keeps a failed job visible when an upload contains invalid JSON', async () => {
    const job = await upload('spotify', 'endsong.json', '[{"ts":')
    await drainJobs()
    expect(body(await read('history/imports'), HistoryImports).items.find(item => item.id === job.id))
      .toMatchObject({ status: 'failed', processed: 0, error: 'The file contains invalid JSON or CSV' })
  })

  it('streams all plays across page boundaries even if their timestamps collide', async () => {
    const viewer = await signIn()
    const album = await createAlbum()
    const recordingId = album.tracks[0]!.recordingId
    const startedAt = new Date('2023-04-15T12:30:00Z')
    await db.insert(plays).values(Array.from({ length: 1010 }, () => ({
      id: newId(), userId: viewer.id, recordingId, startedAt, contextType: 'album', contextId: album.albumId,
    })))
    const rows = (await read('history/export?format=json', viewer)).json<{ id: string; contextId: string }[]>()
    expect(rows).toHaveLength(1010)
    expect(new Set(rows.map(row => row.id)).size).toBe(1010)
    expect(rows[0]?.contextId).toBe(album.albumId)
  })
})
