import { eq } from 'drizzle-orm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { db } from '../database/client.js'
import { httpCache, rateLimits } from '../database/schema.js'
import { useTestDatabase } from '../test/database.js'
import { cachedFetch, ProviderError, rateLimit, userAgent } from './http.js'

type Handler = (url: string, init: RequestInit) => Response | Promise<Response>

/** Stubs fetch with `handler` and returns the list of URLs it was called with. */
function stubFetch(handler: Handler) {
  const calls: { url: string; init: RequestInit }[] = []
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    return handler(url, init)
  })
  return calls
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })

describe('lib/http', () => {
  useTestDatabase()
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('sends the identifying User-Agent and parses JSON', async () => {
    const calls = stubFetch(() => json({ hello: 'world' }))
    const result = await cachedFetch('test', 'https://example.test/ua', { ttlSeconds: 60 })
    expect(result).toEqual({ status: 200, json: { hello: 'world' }, text: '{"hello":"world"}', cached: false })
    expect(userAgent()).toMatch(/^Squirmy\/\d+\.\d+\.\d+ \( https:\/\/github\.com\/IsaacThoman\/squirmy \)$/)
    expect((calls[0]!.init.headers as Record<string, string>)['User-Agent']).toBe(userAgent())
  })

  it('serves fresh cache rows, refetches expired ones and honors the cache modes', async () => {
    let count = 0
    const calls = stubFetch(() => json({ count: ++count }))
    const url = 'https://example.test/cached'

    expect((await cachedFetch('test', url, { ttlSeconds: 60 })).json).toEqual({ count: 1 })
    const hit = await cachedFetch('test', url, { ttlSeconds: 60 })
    expect(hit).toMatchObject({ json: { count: 1 }, cached: true })
    expect(calls).toHaveLength(1)

    expect((await cachedFetch('test', url, { ttlSeconds: 60, cache: 'reload' })).json).toEqual({ count: 2 })
    expect((await cachedFetch('test', url, { ttlSeconds: 60 })).json).toEqual({ count: 2 })
    expect((await cachedFetch('test', url, { ttlSeconds: 60, cache: 'no-store' })).json).toEqual({ count: 3 })
    expect((await cachedFetch('test', url, { ttlSeconds: 60 })).json).toEqual({ count: 2 })

    await db.update(httpCache).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(httpCache.url, url))
    expect((await cachedFetch('test', url, { ttlSeconds: 60 })).json).toEqual({ count: 4 })
    expect(calls).toHaveLength(4)
  })

  it('keys POST requests on their body and masks credentials in the stored URL', async () => {
    stubFetch((_url, init) => json({ echo: init.body }))
    const url = 'https://example.test/post?api_key=secret123&q=1'
    const a = await cachedFetch('test', url, { ttlSeconds: 60, method: 'POST', body: 'a' })
    const b = await cachedFetch('test', url, { ttlSeconds: 60, method: 'POST', body: 'b' })
    expect([a.json, b.json]).toEqual([{ echo: 'a' }, { echo: 'b' }])
    expect((await cachedFetch('test', url, { ttlSeconds: 60, method: 'POST', body: 'a' })).cached).toBe(true)
    const rows = await db.select({ url: httpCache.url }).from(httpCache).where(eq(httpCache.provider, 'test'))
    expect(rows.map((row) => row.url).join(' ')).not.toContain('secret123')
  })

  it('caches 404s for a shorter time and never caches 5xx', async () => {
    stubFetch((url) => url.endsWith('missing') ? json({ error: 'not found' }, 404) : new Response('boom', { status: 500 }))
    const before = Date.now()
    const missing = await cachedFetch('test', 'https://example.test/missing', { ttlSeconds: 30 * 86400 })
    expect(missing.status).toBe(404)
    const [row] = await db.select().from(httpCache).where(eq(httpCache.url, 'https://example.test/missing'))
    expect(row!.expiresAt.getTime() - before).toBeLessThanOrEqual(6 * 3600 * 1000 + 5000)
    expect((await cachedFetch('test', 'https://example.test/missing', { ttlSeconds: 30 * 86400 })).cached).toBe(true)

    const broken = await cachedFetch('test', 'https://example.test/broken', { ttlSeconds: 60 })
    expect(broken).toMatchObject({ status: 500, text: 'boom', cached: false })
    expect(await db.select().from(httpCache).where(eq(httpCache.url, 'https://example.test/broken'))).toHaveLength(0)
  })

  it('caches other 4xx only when asked', async () => {
    stubFetch(() => json({ error: 'bad' }, 400))
    await cachedFetch('test', 'https://example.test/bad-1', { ttlSeconds: 60 })
    await cachedFetch('test', 'https://example.test/bad-2', { ttlSeconds: 60, cacheErrors: true })
    const rows = await db.select({ url: httpCache.url }).from(httpCache).where(eq(httpCache.provider, 'test'))
    expect(rows.map((row) => row.url)).toContain('https://example.test/bad-2')
    expect(rows.map((row) => row.url)).not.toContain('https://example.test/bad-1')
  })

  it('retries 503 after the Retry-After delay', async () => {
    let attempts = 0
    stubFetch(() => ++attempts === 1 ? new Response('busy', { status: 503, headers: { 'retry-after': '1' } }) : json({ ok: true }))
    const started = Date.now()
    const result = await cachedFetch('test', 'https://example.test/busy', { ttlSeconds: 60 })
    expect(result.json).toEqual({ ok: true })
    expect(attempts).toBe(2)
    expect(Date.now() - started).toBeGreaterThanOrEqual(950)
  })

  it('gives up after the configured retries and returns the throttled response uncached', async () => {
    const calls = stubFetch(() => new Response('slow down', { status: 429, headers: { 'retry-after': '0' } }))
    const result = await cachedFetch('test', 'https://example.test/throttled', { ttlSeconds: 60, retries: 2 })
    expect(result.status).toBe(429)
    expect(calls).toHaveLength(3)
    expect(await db.select().from(httpCache).where(eq(httpCache.url, 'https://example.test/throttled'))).toHaveLength(0)
  })

  it('lets a client classify 200 bodies as throttled or missing', async () => {
    let attempts = 0
    stubFetch(() => ++attempts === 1 ? json({ error: { code: 4 } }) : json({ error: { code: 800 } }))
    const result = await cachedFetch('test', 'https://example.test/classify', {
      ttlSeconds: 30 * 86400,
      classify: (response) => {
        const code = (response.json as { error?: { code: number } }).error?.code
        return code === 4 ? 'retry' : code === 800 ? 'miss' : undefined
      },
    })
    expect(result.json).toEqual({ error: { code: 800 } })
    const [row] = await db.select().from(httpCache).where(eq(httpCache.url, 'https://example.test/classify'))
    expect(row!.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(6 * 3600 * 1000)
  })

  it('times out slow requests with a ProviderError', async () => {
    stubFetch((_url, init) => new Promise((_resolve, reject) => {
      init.signal!.addEventListener('abort', () => reject(init.signal!.reason))
    }))
    const failure = cachedFetch('test', 'https://example.test/slow', { ttlSeconds: 60, timeoutMs: 50 })
    await expect(failure).rejects.toBeInstanceOf(ProviderError)
    await expect(failure).rejects.toThrow(/timed out after 50 ms/)
  })

  it('spaces concurrent callers on one key and keeps keys independent', async () => {
    const interval = 150
    const started = Date.now()
    const finished: number[] = []
    await Promise.all(Array.from({ length: 5 }, () => rateLimit('test:queue', interval).then(() => finished.push(Date.now()))))
    finished.sort((a, b) => a - b)
    // The gap between two callers finishing is not bounded below: each sleeps from the
    // moment its reservation comes back, and a slow round trip for one delays only that
    // one. The slots are: the database hands out one per interval from the first, so the
    // k-th caller to finish cannot finish before k intervals have passed. The few
    // milliseconds of slack cover Date.now() rounding and timers that fire a little early.
    for (const [index, at] of finished.entries()) expect(at - started).toBeGreaterThanOrEqual(interval * index - 5)

    // A key of its own has no queue to wait behind.
    expect(await rateLimit('test:other', interval)).toBe(0)
  })

  it('rate-limits each network attempt of cachedFetch but not cache hits', async () => {
    stubFetch(() => json({ ok: true }))
    const started = Date.now()
    const options = { ttlSeconds: 60, rateLimitKey: 'test:fetch', rateLimitMs: 200 }
    await Promise.all([
      cachedFetch('test', 'https://example.test/limited-1', options),
      cachedFetch('test', 'https://example.test/limited-2', options),
      cachedFetch('test', 'https://example.test/limited-3', options),
    ])
    expect(Date.now() - started).toBeGreaterThanOrEqual(385)
    // A cache hit takes no slot: the next reservation stays where the misses left it.
    const nextSlot = async () => (await db.select({ nextAt: rateLimits.nextAt }).from(rateLimits).where(eq(rateLimits.key, 'test:fetch')))[0]!.nextAt
    const reserved = await nextSlot()
    expect((await cachedFetch('test', 'https://example.test/limited-1', options)).cached).toBe(true)
    expect(await nextSlot()).toEqual(reserved)
  })
})
