import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, unlink } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import type { ProviderRecordingQuery } from '@squirmy/contracts'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createColdStorage, type ColdStorageProvider } from './index.js'

const run = promisify(execFile)
let pitch = 300

/** A short, near-silent tagged tone, like the server's test fixtures. */
async function tone(root: string, file: string, seconds: number, tags: Record<string, string | number>) {
  const output = path.join(root, file)
  await mkdir(path.dirname(output), { recursive: true })
  const args = ['-v', 'error', '-y', '-f', 'lavfi', '-i', `sine=frequency=${pitch += 20}:duration=${seconds}:sample_rate=44100`, '-af', 'volume=-50dB', '-ac', '2']
  args.push(...(file.endsWith('.mp3') ? ['-c:a', 'libmp3lame', '-b:a', '128k', '-id3v2_version', '3'] : ['-c:a', 'flac']))
  for (const [key, value] of Object.entries(tags)) args.push('-metadata', `${key}=${value}`)
  await run(process.env.FFMPEG_PATH ?? 'ffmpeg', [...args, output])
}

const query = (input: Partial<ProviderRecordingQuery>): ProviderRecordingQuery => ({ mbid: null, isrcs: [], title: '', artist: '', durationMs: null, album: null, ...input })
const recordingMbid = '5b11f4ce-a62d-471e-81fc-a69a8278c7da'
const groupMbid = '0f2c2b1a-0000-4000-8000-000000000001'

type Received = { url: string; authorization: string | undefined; body: string }

describe('cold storage', () => {
  let folder = ''
  let provider: ColdStorageProvider
  let base = ''
  let sink: Server
  let sinkUrl = ''
  const received: Received[] = []

  beforeAll(async () => {
    folder = await mkdtemp(path.join(tmpdir(), 'squirmy-cold-'))
    await tone(folder, 'Calm Waters/Still/01 Dawn.flac', 4, {
      title: 'Dawn', artist: 'Calm Waters', album_artist: 'Calm Waters', album: 'Still', track: '1/2', MUSICBRAINZ_TRACKID: recordingMbid, MUSICBRAINZ_RELEASEGROUPID: groupMbid,
    })
    await tone(folder, 'Calm Waters/Still/02 Dusk.flac', 5, { title: 'Dusk', artist: 'Calm Waters', album_artist: 'Calm Waters', album: 'Still', track: '2/2', ISRC: 'QZAAA2400001', MUSICBRAINZ_RELEASEGROUPID: groupMbid })
    await tone(folder, 'Mixed/Cafe.mp3', 6, { title: 'Café Noir', artist: 'Calm Waters feat. Guest', album: 'Mixed Bag' })
    await tone(folder, 'Mixed/Twice A.flac', 3, { title: 'Twice', artist: 'Echo', album: 'First' })
    await tone(folder, 'Mixed/Twice B.flac', 9, { title: 'Twice', artist: 'Echo', album: 'Second' })
    provider = createColdStorage({ folder, secret: 'cold-secret' })
    await provider.index.scan()
    base = await provider.listen()

    sink = createServer((request, response) => {
      const chunks: Buffer[] = []
      request.on('data', (chunk: Buffer) => chunks.push(chunk))
      request.on('end', () => {
        received.push({ url: request.url ?? '', authorization: request.headers.authorization, body: Buffer.concat(chunks).toString('latin1') })
        // Uploads take a moment, so a repeated acquire lands while a delivery is under way.
        setTimeout(() => {
          response.writeHead(200, { 'content-type': 'application/json' })
          response.end('{"files":[]}')
        }, request.url === '/files' ? 200 : 0)
      })
    })
    await new Promise<void>((resolve) => sink.listen(0, '127.0.0.1', resolve))
    sinkUrl = `http://127.0.0.1:${(sink.address() as AddressInfo).port}`
  }, 60_000)

  afterAll(async () => {
    await provider.close()
    sink.closeAllConnections()
    await new Promise((resolve) => sink.close(resolve))
    await rm(folder, { recursive: true, force: true })
  })

  const call = (route: string, body?: unknown, secret = 'cold-secret') => fetch(`${base}${route}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })

  it('indexes the tags of every audio file', () => {
    const dawn = provider.index.all().find((file) => file.title === 'Dawn')
    expect(dawn).toMatchObject({ artist: 'Calm Waters', album: 'Still', recordingMbid, releaseGroupMbid: groupMbid, track: 1, format: 'flac', lossless: true, relPath: 'Calm Waters/Still/01 Dawn.flac' })
    expect(dawn!.durationMs).toBeGreaterThan(3900)
    expect(provider.index.all()).toHaveLength(5)
  })

  it('matches by MusicBrainz id first, then ISRC, then artist, title and length', () => {
    const index = provider.index
    // The id wins even when nothing else agrees.
    expect(index.matchRecording(query({ mbid: recordingMbid.toUpperCase(), title: 'Something Else', artist: 'Nobody', durationMs: 1000 }))?.title).toBe('Dawn')
    expect(index.matchRecording(query({ isrcs: ['qzaaa2400001'], title: 'Renamed', artist: 'Nobody' }))?.title).toBe('Dusk')
    expect(index.matchRecording(query({ title: 'dusk', artist: 'CALM WATERS', durationMs: 7_000 }))?.title).toBe('Dusk')
    expect(index.matchRecording(query({ title: 'Dusk', artist: 'Calm Waters', durationMs: 8_100 }))).toBeNull()
    // Accents and punctuation do not matter, and a featured credit matches its main artist.
    expect(index.matchRecording(query({ title: 'Cafe Noir!', artist: 'Calm Waters', durationMs: 6_000 }))?.relPath).toBe('Mixed/Cafe.mp3')
    // Edition suffixes are not part of the title; other suffixes are.
    expect(index.matchRecording(query({ title: 'Dusk (Remastered 2009)', artist: 'Calm Waters', durationMs: 5_000 }))?.title).toBe('Dusk')
    expect(index.matchRecording(query({ title: 'Dusk (Live)', artist: 'Calm Waters', durationMs: 5_000 }))).toBeNull()
    // An unknown id falls through to the next rules.
    expect(index.matchRecording(query({ mbid: '00000000-0000-4000-8000-000000000000', title: 'Dusk', artist: 'Calm Waters', durationMs: 5_000 }))?.title).toBe('Dusk')
  })

  it('picks the closest length, and without one needs the album or a single candidate', () => {
    const index = provider.index
    expect(index.matchRecording(query({ title: 'Twice', artist: 'Echo', durationMs: 8_000 }))?.album).toBe('Second')
    expect(index.matchRecording(query({ title: 'Twice', artist: 'Echo' }))).toBeNull()
    expect(index.matchRecording(query({ title: 'Twice', artist: 'Echo', album: { title: 'First', mbid: null, year: null, disc: null, position: null } }))?.album).toBe('First')
    expect(index.matchRecording(query({ title: 'Cafe Noir', artist: 'Calm Waters' }))?.relPath).toBe('Mixed/Cafe.mp3')
  })

  it('matches albums by release group, then by artist and title', () => {
    const tracks: [] = []
    expect(provider.index.matchAlbum({ mbid: groupMbid, title: 'x', artist: 'y', year: null, barcode: null, tracks }).map((file) => file.title)).toEqual(['Dawn', 'Dusk'])
    expect(provider.index.matchAlbum({ mbid: null, title: 'STILL (Deluxe Edition)', artist: 'Calm Waters', year: null, barcode: null, tracks }).map((file) => file.title)).toEqual(['Dawn', 'Dusk'])
    expect(provider.index.matchAlbum({ mbid: null, title: 'Unknown', artist: 'Calm Waters', year: null, barcode: null, tracks })).toEqual([])
  })

  it('rescans only what changed', async () => {
    await tone(folder, 'Later/New.flac', 2, { title: 'New Arrival', artist: 'Echo' })
    await unlink(path.join(folder, 'Mixed/Twice B.flac'))
    expect(await provider.index.scan()).toEqual({ files: 5, read: 1 })
    expect(provider.index.all().map((file) => file.title).sort()).toEqual(['Café Noir', 'Dawn', 'Dusk', 'New Arrival', 'Twice'])
  })

  it('speaks the protocol: secret, capabilities, resolve and acquire with delivery', async () => {
    expect((await call('/capabilities', undefined, 'wrong-secret')).status).toBe(401)
    expect(await (await call('/capabilities')).json()).toEqual({
      protocol: 1, name: 'Cold storage', coverage: 'must_resolve', kinds: ['recording', 'album'], formats: ['flac', 'mp3'], maxConcurrent: 2,
    })
    expect((await call('/resolve', { items: [] })).status).toBe(400)

    const resolved = await (await call('/resolve', {
      items: [
        { ref: 'a', kind: 'recording', recording: query({ title: 'Dawn', artist: 'Calm Waters', durationMs: 4000 }) },
        { ref: 'b', kind: 'recording', recording: query({ title: 'Not Here', artist: 'Nobody', durationMs: 4000 }) },
        { ref: 'c', kind: 'album', album: { mbid: groupMbid, title: 'Still', artist: 'Calm Waters', year: null, barcode: null, tracks: [] } },
      ],
    })).json() as { items: { ref: string; offers: { offerId: string; lossless: boolean; format: string }[] }[] }
    expect(resolved.items.map((item) => [item.ref, item.offers.length])).toEqual([['a', 1], ['b', 0], ['c', 1]])
    expect(resolved.items[0]!.offers[0]).toMatchObject({ format: 'flac', lossless: true })

    const delivery = (token: string) => ({ uploadUrl: `${sinkUrl}/files`, completeUrl: `${sinkUrl}/complete`, token })
    const jobId = '01937f0e-0000-7000-8000-000000000001'
    const album = { jobId, offerId: resolved.items[2]!.offers[0]!.offerId, delivery: delivery('first-token') }
    expect(await (await call('/acquire', album)).json()).toEqual({ accepted: true, providerJobId: jobId })
    // The same job again, with a fresh token: no second delivery, and the new token is used.
    expect(await (await call('/acquire', { ...album, delivery: delivery('second-token') })).json()).toEqual({ accepted: true, providerJobId: jobId })
    await provider.jobs.get(jobId)!.done
    expect(await (await call(`/jobs/${jobId}`)).json()).toEqual({ status: 'completed', error: null })

    expect(received.map((request) => request.url)).toEqual(['/files', '/files', '/complete'])
    expect(received.at(-1)!.authorization).toBe('Bearer second-token')
    expect(received[0]!.body).toContain('Still/01 Dawn.flac')
    expect(received[0]!.body).toContain('filename="01 Dawn.flac"')
    expect(received[0]!.body).toContain('fLaC')
    expect(received[1]!.body).toContain('Still/02 Dusk.flac')
    expect(received[2]!.body).toBe('{"status":"completed"}')

    received.length = 0
    const missing = '01937f0e-0000-7000-8000-000000000002'
    await call('/acquire', { jobId: missing, offerId: 'file:gone', delivery: delivery('third-token') })
    await provider.jobs.get(missing)!.done
    expect(received).toMatchObject([{ url: '/complete', body: '{"status":"failed","error":"That file is no longer in cold storage"}' }])
    expect((await call('/jobs/unknown')).status).toBe(404)
  })
})
