import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createProviderServer, ProviderBusyError, textKey, titleKey, type ProviderServer } from './index.js'

describe('provider kit', () => {
  let provider: ProviderServer
  let base = ''
  let fetches = 0
  let busy = false

  beforeAll(async () => {
    provider = createProviderServer({
      secret: 'kit-secret-value',
      capabilities: { name: 'Kit', coverage: 'must_resolve', kinds: ['recording'], formats: [], maxConcurrent: 1 },
      resolve: () => [],
      fetch: async () => {
        fetches += 1
        throw new Error('nothing to fetch')
      },
      onError: () => {},
      busy: () => busy,
    })
    base = await provider.listen()
  })
  afterAll(() => provider.close())

  const request = (route: string, init: { body?: string; secret?: string } = {}) => fetch(`${base}${route}`, {
    method: init.body === undefined ? 'GET' : 'POST',
    headers: { authorization: `Bearer ${init.secret ?? 'kit-secret-value'}` },
    body: init.body,
  })

  it('checks the secret and validates every request', async () => {
    expect((await request('/capabilities', { secret: 'kit-secret-valuE' })).status).toBe(401)
    expect((await request('/capabilities', { secret: '' })).status).toBe(401)
    expect(await (await request('/capabilities')).json()).toEqual({ protocol: 1, name: 'Kit', coverage: 'must_resolve', kinds: ['recording'], formats: [], maxConcurrent: 1 })
    expect((await request('/resolve', { body: 'not json' })).status).toBe(400)
    expect((await request('/acquire', { body: JSON.stringify({ jobId: 'not-a-uuid', offerId: 'x' }) })).status).toBe(400)
    expect((await request('/elsewhere')).status).toBe(404)
  })

  it('runs an acquire job once per job id', async () => {
    const body = JSON.stringify({
      jobId: '01937f0e-0000-7000-8000-000000000123', offerId: 'x',
      delivery: { uploadUrl: 'http://127.0.0.1:9/files', completeUrl: 'http://127.0.0.1:9/complete', token: 't' },
    })
    expect(await (await request('/acquire', { body })).json()).toEqual({ accepted: true, providerJobId: '01937f0e-0000-7000-8000-000000000123' })
    expect(await (await request('/acquire', { body })).json()).toEqual({ accepted: true, providerJobId: '01937f0e-0000-7000-8000-000000000123' })
    await provider.jobs.get('01937f0e-0000-7000-8000-000000000123')!.done
    expect(fetches).toBe(1)
    expect(await (await request('/jobs/01937f0e-0000-7000-8000-000000000123')).json()).toEqual({ status: 'failed', error: 'nothing to fetch' })
  })

  it('declines a new job as busy when told to, and takes it when asked again', async () => {
    const body = JSON.stringify({
      jobId: '01937f0e-0000-7000-8000-000000000456', offerId: 'x',
      delivery: { uploadUrl: 'http://127.0.0.1:9/files', completeUrl: 'http://127.0.0.1:9/complete', token: 't' },
    })
    busy = true
    expect(await (await request('/acquire', { body })).json()).toEqual({ accepted: false, error: 'Provider is busy', reason: 'busy' })
    expect(provider.jobs.has('01937f0e-0000-7000-8000-000000000456')).toBe(false)
    busy = false
    expect(await (await request('/acquire', { body })).json()).toEqual({ accepted: true, providerJobId: '01937f0e-0000-7000-8000-000000000456' })
    await provider.jobs.get('01937f0e-0000-7000-8000-000000000456')!.done
  })

  it('answers a busy resolve with 429 and Retry-After, and reports a busy fetch so the server sends it again', async () => {
    // Stands in for the server's delivery URLs: records what the provider reports.
    const reports: unknown[] = []
    const server = createServer((request, response) => {
      let text = ''
      request.on('data', (chunk) => (text += chunk))
      request.on('end', () => {
        reports.push(JSON.parse(text))
        response.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}')
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const delivery = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    let limited = 1
    let fetched = 0
    const busyProvider = createProviderServer({
      secret: 'kit-secret-value',
      capabilities: { name: 'Limited', coverage: 'must_resolve', kinds: ['recording'], formats: [], maxConcurrent: 1, version: '2.1.0' },
      resolve: () => {
        throw new ProviderBusyError('Rate limited', 30)
      },
      fetch: async () => {
        fetched += 1
        if (limited-- > 0) throw new ProviderBusyError('Rate limited by the source')
        return { files: [] }
      },
      onError: () => {},
    })
    const url = await busyProvider.listen()
    const call = (route: string, body?: string) => fetch(`${url}${route}`, { method: body === undefined ? 'GET' : 'POST', headers: { authorization: 'Bearer kit-secret-value' }, body })
    try {
      expect(await (await call('/capabilities')).json()).toMatchObject({ version: '2.1.0' })
      const resolved = await call('/resolve', JSON.stringify({ items: [{ ref: '1', kind: 'recording', recording: { mbid: null, isrcs: [], title: 'T', artist: 'A', durationMs: null, album: null } }] }))
      expect(resolved.status).toBe(429)
      expect(resolved.headers.get('retry-after')).toBe('30')

      const jobId = '01937f0e-0000-7000-8000-000000000789'
      const body = JSON.stringify({ jobId, offerId: 'x', delivery: { uploadUrl: `${delivery}/files`, completeUrl: `${delivery}/complete`, token: 't' } })
      expect(await (await call('/acquire', body)).json()).toEqual({ accepted: true, providerJobId: jobId })
      await busyProvider.jobs.get(jobId)!.done
      expect(reports).toEqual([{ status: 'failed', error: 'Rate limited by the source', reason: 'busy' }])
      expect(await (await call(`/jobs/${jobId}`)).json()).toEqual({ status: 'failed', error: 'Rate limited by the source', reason: 'busy' })

      // Sent again: a busy failure runs again, where any other failure would not.
      expect(await (await call('/acquire', body)).json()).toEqual({ accepted: true, providerJobId: jobId })
      await busyProvider.jobs.get(jobId)!.done
      expect(fetched).toBe(2)
      expect(reports.at(-1)).toEqual({ status: 'completed' })
    } finally {
      await busyProvider.close()
      server.close()
    }
  })

  it('compares text without case, accents or punctuation', () => {
    expect(textKey('  Zoë & The Café-Band: Déjà Vu! ')).toBe('zoe and the cafe band deja vu')
  })

  it('drops edition suffixes from titles, but not ones that name different music', () => {
    expect(titleKey('Something (Remastered 2009)')).toBe('something')
    expect(titleKey('Long Song - 2015 Remaster')).toBe('long song')
    expect(titleKey('Album [Deluxe Edition] (feat. Guest)')).toBe('album')
    expect(titleKey('Song (Live)')).toBe('song live')
    expect(titleKey('Song (2019 Mix)')).toBe('song 2019 mix')
    expect(titleKey('(Remastered)')).toBe('remastered')
  })
})
