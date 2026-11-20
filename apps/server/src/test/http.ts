import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, beforeAll, beforeEach, expect, vi } from 'vitest'
import { setRateLimitsEnabled } from '../lib/http.js'

/** One recorded exchange, stored as `src/test/http/<provider>/<name>.json`. */
export type HttpFixture = {
  /** Why the fixture was trimmed or written by hand, when it was. */
  note?: string
  request: { method: string; url: string; body?: string }
  response: {
    status: number
    headers?: Record<string, string>
    /** Exactly one of these holds the body. */
    json?: unknown
    text?: string
    base64?: string
  }
}

const root = fileURLToPath(new URL('./http/', import.meta.url))
const keptHeaders = ['content-type', 'retry-after', 'location']

/**
 * Replaces `fetch` for the current test file with recorded responses from
 * `src/test/http/<provider>/`, matched on method, URL and body. A request with no
 * fixture fails the test. With `SQUIRMY_RECORD_HTTP=1`, unrecorded requests go to the
 * network and are saved into the first provider's folder; existing fixtures still win.
 *
 * Returns the list of requests made, as `METHOD URL`, for assertions.
 */
export function useHttpFixtures(...providers: string[]) {
  const recording = process.env.SQUIRMY_RECORD_HTTP === '1'
  const fixtures = new Map<string, HttpFixture>()
  const requests: string[] = []
  const unmatched: string[] = []
  const realFetch = globalThis.fetch

  beforeAll(async () => {
    for (const provider of providers) {
      const directory = path.join(root, provider)
      if (!existsSync(directory)) continue
      for (const file of await readdir(directory)) {
        if (!file.endsWith('.json')) continue
        const fixture = JSON.parse(await readFile(path.join(directory, file), 'utf8')) as HttpFixture
        fixtures.set(fixtureKey(fixture.request.method, fixture.request.url, fixture.request.body), fixture)
      }
    }
    setRateLimitsEnabled(recording)
  })

  afterAll(() => setRateLimitsEnabled(true))

  // Installed for the whole file, not per test: a `beforeAll` that reaches a provider
  // runs before any `beforeEach`, and must not find the real fetch.
  const install = () => {
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : input.toString()
      const method = (init?.method ?? 'GET').toUpperCase()
      const body = typeof init?.body === 'string' ? init.body : undefined
      requests.push(`${method} ${url}`)
      const fixture = fixtures.get(fixtureKey(method, url, body))
      if (fixture) return toResponse(fixture)
      if (!recording) {
        unmatched.push(`${method} ${url}`)
        throw new Error(`No HTTP fixture for ${method} ${url}. Record it with SQUIRMY_RECORD_HTTP=1.`)
      }
      const response = await realFetch(url, init)
      const recorded = await fromResponse({ method, url, ...(body === undefined ? {} : { body }) }, response)
      // A throttled or failing service is not a response worth replaying forever.
      if (response.status === 429 || response.status >= 500) return toResponse(recorded)
      await save(providers[0] ?? 'misc', recorded)
      fixtures.set(fixtureKey(method, url, body), recorded)
      return toResponse(recorded)
    })
  }

  beforeAll(install)

  beforeEach(() => {
    requests.length = 0
    unmatched.length = 0
    // Again, in case the previous test stubbed fetch itself.
    install()
  })

  afterEach(() => {
    expect(unmatched, 'requests without a recorded fixture').toEqual([])
  })

  afterAll(() => vi.unstubAllGlobals())

  return { requests }
}

function fixtureKey(method: string, url: string, body?: string) {
  return `${method.toUpperCase()} ${url}\n${body ?? ''}`
}

function toResponse(fixture: HttpFixture): Response {
  const { status, headers, json, text, base64 } = fixture.response
  const body = base64 !== undefined ? Buffer.from(base64, 'base64') : json !== undefined ? JSON.stringify(json) : (text ?? '')
  return new Response([101, 204, 205, 304].includes(status) ? null : body, { status, headers })
}

async function fromResponse(request: HttpFixture['request'], response: Response): Promise<HttpFixture> {
  const headers: Record<string, string> = {}
  for (const name of keptHeaders) {
    const value = response.headers.get(name)
    if (value) headers[name] = value
  }
  const type = headers['content-type'] ?? ''
  const bytes = Buffer.from(await response.arrayBuffer())
  const result: HttpFixture['response'] = { status: response.status, headers }
  if (/json/.test(type)) {
    try {
      result.json = JSON.parse(bytes.toString('utf8'))
    } catch {
      result.text = bytes.toString('utf8')
    }
  } else if (/^text\/|xml|javascript/.test(type) || type === '') result.text = bytes.toString('utf8')
  else result.base64 = bytes.toString('base64')
  return { request, response: result }
}

async function save(provider: string, fixture: HttpFixture) {
  const { method, url, body } = fixture.request
  const parsed = new URL(url)
  const slug = `${parsed.hostname}${parsed.pathname}${parsed.search}`
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 90)
  const hash = createHash('sha256').update(fixtureKey(method, url, body)).digest('hex').slice(0, 8)
  const directory = path.join(root, provider)
  await mkdir(directory, { recursive: true })
  await writeFile(path.join(directory, `${method.toLowerCase()}-${slug}-${hash}.json`), `${JSON.stringify(fixture, null, 2)}\n`)
}
