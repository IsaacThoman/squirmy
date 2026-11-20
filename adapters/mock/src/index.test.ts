import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { parseBuffer } from 'music-metadata'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createMockProvider, type MockProvider } from './index.js'

type Upload = { name: string; audio: Buffer }

/** Pulls the file parts out of a multipart body. */
function files(body: Buffer, contentType: string): Upload[] {
  const boundary = `--${/boundary=(.+)$/.exec(contentType)![1]}`
  const parts: Upload[] = []
  let start = body.indexOf(boundary)
  while (start >= 0) {
    const next = body.indexOf(boundary, start + boundary.length)
    if (next < 0) break
    const part = body.subarray(start + boundary.length + 2, next - 2)
    const split = part.indexOf('\r\n\r\n')
    const headers = part.subarray(0, split).toString()
    const name = /filename="([^"]+)"/.exec(headers)?.[1]
    if (name) parts.push({ name, audio: part.subarray(split + 4) })
    start = next
  }
  return parts
}

describe('mock provider', () => {
  let mock: MockProvider
  let base = ''
  let sink: Server
  let sinkUrl = ''
  let uploads: Upload[] = []
  let completions: unknown[] = []

  beforeAll(async () => {
    mock = createMockProvider({ secret: 'mock-test-secret', onError: () => {} })
    base = await mock.listen()
    sink = createServer((request, response) => {
      const chunks: Buffer[] = []
      request.on('data', (chunk: Buffer) => chunks.push(chunk))
      request.on('end', () => {
        const body = Buffer.concat(chunks)
        if (request.url === '/files') uploads.push(...files(body, request.headers['content-type']!))
        else completions.push(JSON.parse(body.toString()))
        response.end('{}')
      })
    })
    await new Promise<void>((resolve) => sink.listen(0, '127.0.0.1', resolve))
    sinkUrl = `http://127.0.0.1:${(sink.address() as AddressInfo).port}`
  })
  beforeEach(() => {
    uploads = []
    completions = []
    Object.assign(mock.settings, { delayMs: 0, fail: false, wrongFile: false, priced: false })
  })
  afterAll(async () => {
    await mock.close()
    sink.closeAllConnections()
    await new Promise((resolve) => sink.close(resolve))
  })

  const post = async (route: string, body: unknown) => (await fetch(`${base}${route}`, {
    method: 'POST', headers: { authorization: 'Bearer mock-test-secret', 'content-type': 'application/json' }, body: JSON.stringify(body),
  })).json() as Promise<Record<string, unknown>>
  const recording = { mbid: '5b11f4ce-a62d-471e-81fc-a69a8278c7da', isrcs: ['QZAAA2400009'], title: 'Hum', artist: 'Tone Generator', durationMs: 2400, album: { title: 'Sines', mbid: null, year: 2024, disc: 1, position: 3 } }
  const offerFor = async () => {
    const resolved = await post('/resolve', { items: [{ ref: '1', kind: 'recording', recording }] }) as { items: { offers: { offerId: string; price?: unknown }[] }[] }
    return resolved.items[0]!.offers[0]!
  }
  let serial = 0
  const acquire = async (offerId: string) => {
    const jobId = `01937f0e-0000-7000-8000-${String(++serial).padStart(12, '0')}`
    await post('/acquire', { jobId, offerId, delivery: { uploadUrl: `${sinkUrl}/files`, completeUrl: `${sinkUrl}/complete`, token: 'token' } })
    await mock.jobs.get(jobId)!.done
    return mock.jobs.get(jobId)!
  }

  it('delivers a quiet tone of the requested length with the requested tags', async () => {
    const job = await acquire((await offerFor()).offerId)
    expect(job.status).toBe('completed')
    expect(uploads.map((upload) => upload.name)).toEqual(['03 Hum.flac'])
    const { common, format } = await parseBuffer(uploads[0]!.audio, { mimeType: 'audio/flac' })
    expect(common).toMatchObject({ title: 'Hum', artist: 'Tone Generator', album: 'Sines', year: 2024, musicbrainz_recordingid: recording.mbid, isrc: ['QZAAA2400009'] })
    expect(common.track.no).toBe(3)
    expect(format.duration).toBeCloseTo(2, 0)
    expect(completions).toEqual([{ status: 'completed' }])
  })

  it('can deliver the wrong file, fail, or put a price on its offers', async () => {
    mock.settings.wrongFile = true
    await acquire((await offerFor()).offerId)
    const { common, format } = await parseBuffer(uploads[0]!.audio, { mimeType: 'audio/flac' })
    expect(common.title).toBe('Hum (Something Else)')
    expect(format.duration).toBeGreaterThan(60)

    mock.settings.wrongFile = false
    mock.settings.fail = true
    expect((await acquire((await offerFor()).offerId)).status).toBe('failed')
    expect(completions.at(-1)).toEqual({ status: 'failed', error: 'The mock provider was told to fail' })

    mock.settings.priced = true
    expect((await offerFor()).price).toEqual({ amount: '0.99', currency: 'USD' })
  })

  it('reports what it has for must_resolve coverage', async () => {
    mock.settings.has = (item) => item.kind === 'recording' && item.recording.title !== 'Hum'
    const resolved = await post('/resolve', { items: [{ ref: '1', kind: 'recording', recording }, { ref: '2', kind: 'recording', recording: { ...recording, title: 'Buzz' } }] }) as { items: { ref: string; offers: unknown[] }[] }
    expect(resolved.items.map((item) => item.offers.length)).toEqual([0, 1])
    mock.settings.has = () => true
  })
})
