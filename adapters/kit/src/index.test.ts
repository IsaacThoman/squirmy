import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createProviderServer, textKey, titleKey, type ProviderServer } from './index.js'

describe('provider kit', () => {
  let provider: ProviderServer
  let base = ''
  let fetches = 0

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
