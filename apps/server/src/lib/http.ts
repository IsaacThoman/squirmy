import { createHash } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'
import { and, eq, gt, sql } from 'drizzle-orm'
import { db } from '../database/client.js'
import { httpCache } from '../database/schema.js'
import { AppError } from './errors.js'
import { getVersion } from './version.js'

/** A response as cachedFetch returns it, from the network or from `http_cache`. */
export type HttpResult = {
  status: number
  /** The body parsed as JSON, when it is JSON. */
  json?: unknown
  text: string
  /** True when the result came from `http_cache` without a request. */
  cached: boolean
}

/**
 * How a response is treated. `ok` is cached for `ttlSeconds`, `miss` for a shorter time,
 * `retry` is retried with backoff and never cached, `error` is returned uncached.
 */
export type ResponseKind = 'ok' | 'miss' | 'retry' | 'error'

export type CachedFetchOptions = {
  /** How long a successful response is served from the cache. */
  ttlSeconds: number
  headers?: Record<string, string>
  method?: 'GET' | 'POST'
  /** Request body. Part of the cache key, so POST lookups cache too. */
  body?: string
  /** Callers sharing a key share one queue, across processes. */
  rateLimitKey?: string
  /** Minimum spacing between requests on `rateLimitKey`. */
  rateLimitMs?: number
  /** Also cache 4xx responses other than 404/410, for the miss TTL. Off by default. */
  cacheErrors?: boolean
  /**
   * `default` reads and writes the cache, `reload` skips reading but stores the fresh
   * response, `no-store` neither reads nor writes (use it for submissions).
   */
  cache?: 'default' | 'reload' | 'no-store'
  /** Abort a request that takes longer than this. Default 15 seconds. */
  timeoutMs?: number
  /** Retries after a throttled response. Default 3. */
  retries?: number
  /**
   * Overrides the status-based classification, for APIs that report errors in a 200
   * body (Deezer). Return undefined to fall back to the default.
   */
  classify?: (result: HttpResult) => ResponseKind | undefined
}

/** A provider failed in a way the caller cannot fix: network error, timeout, 5xx, bad key. */
export class ProviderError extends AppError {
  constructor(
    readonly provider: string,
    message: string,
    /** The upstream HTTP status, when there was a response. */
    readonly upstreamStatus?: number,
    /** The provider's own error code, when it sends one (Last.fm, AcoustID, Deezer). */
    readonly upstreamCode?: number | string,
    options?: ErrorOptions,
  ) {
    super(502, 'provider_unavailable', `${provider}: ${message}`)
    if (options?.cause) this.cause = options.cause
    this.name = 'ProviderError'
  }
}

/** Builds the error a client throws for a response it cannot use. */
export function unexpectedResponse(provider: string, result: HttpResult): ProviderError {
  return new ProviderError(provider, `unexpected HTTP ${result.status}: ${result.text.slice(0, 200)}`, result.status)
}

/** Misses are cached for at most this long so a newly added entry shows up soon. */
const missTtlSeconds = 6 * 3600
const defaultTimeoutMs = 15_000
const maxRetryWaitMs = 60_000
/** Most bytes of a body cachedFetch reads. Provider answers are far smaller; more is a fault, and is not kept. */
const maxBodyBytes = 8 * 1024 * 1024
/** Query parameters that carry credentials; masked in the stored URL. */
const secretParams = new Set(['api_key', 'client', 'client_key', 'token', 'sk', 'api_sig'])

/** `Squirmy/<version> ( https://github.com/IsaacThoman/squirmy )`, as every provider asks. */
export function userAgent(): string {
  return `Squirmy/${getVersion()} ( https://github.com/IsaacThoman/squirmy )`
}

let rateLimitsEnabled = true

/**
 * Turns cachedFetch's rate limiting off or on. Tests that replay recorded fixtures turn
 * it off so they do not wait out real intervals; recording keeps it on.
 */
export function setRateLimitsEnabled(enabled: boolean) {
  rateLimitsEnabled = enabled
}

/**
 * Reserves the next request slot for `key` and waits until it. The reservation is one
 * upsert on `rate_limits`, so callers in any process queue in the order the database
 * sees them and are spaced at least `intervalMs` apart. Returns how long it waited, in
 * milliseconds.
 */
export async function rateLimit(key: string, intervalMs: number): Promise<number> {
  const interval = sql`(${intervalMs}::double precision * interval '1 millisecond')`
  const rows = await db.execute<{ wait_ms: number }>(sql`
    with clock as (select clock_timestamp() as now)
    insert into rate_limits as r (key, next_at)
    select ${key}, now + ${interval} from clock
    on conflict (key) do update set next_at = greatest(r.next_at, (select now from clock)) + ${interval}
    returning (extract(epoch from r.next_at - (select now from clock)) * 1000 - ${intervalMs}::double precision)::double precision as wait_ms
  `)
  const wait = Number(rows[0]?.wait_ms ?? 0)
  if (wait <= 0) return 0
  await sleep(wait)
  return wait
}

/**
 * fetch with Squirmy's User-Agent and a timeout. Network failures and timeouts become a
 * ProviderError; HTTP error statuses are returned as they are.
 */
export async function request(provider: string, url: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<Response> {
  const { timeoutMs = defaultTimeoutMs, headers, ...rest } = init
  try {
    return await fetch(url, {
      ...rest,
      headers: { 'User-Agent': userAgent(), ...(headers as Record<string, string> | undefined) },
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (error) {
    const timedOut = error instanceof DOMException && error.name === 'TimeoutError'
    throw new ProviderError(provider, timedOut ? `timed out after ${timeoutMs} ms` : `request failed: ${(error as Error).message}`, undefined, undefined, { cause: error })
  }
}

/** The body as text. Past `maxBodyBytes` it throws ProviderError, without reading the rest. */
async function readBody(provider: string, response: Response): Promise<string> {
  const tooLarge = () => new ProviderError(provider, `response larger than ${maxBodyBytes / 1024 / 1024} MiB`, response.status)
  if (Number(response.headers.get('content-length') ?? 0) > maxBodyBytes) {
    await response.body?.cancel()
    throw tooLarge()
  }
  if (!response.body) return ''
  const chunks: Uint8Array[] = []
  let size = 0
  for await (const chunk of response.body) {
    size += chunk.byteLength
    // Leaving the loop cancels the stream.
    if (size > maxBodyBytes) throw tooLarge()
    chunks.push(chunk)
  }
  // As response.text() does: UTF-8, without a byte order mark.
  return new TextDecoder().decode(Buffer.concat(chunks))
}

/**
 * GETs (or POSTs) a provider URL through the shared response cache.
 *
 * A fresh `http_cache` row is served without a request. Otherwise the call waits for its
 * rate-limit slot, fetches, retries 429/503 with backoff (honoring Retry-After), and
 * stores the result: successes for `ttlSeconds`, 404/410 for at most six hours, 5xx
 * never. Network failures, timeouts and bodies over 8 MiB throw ProviderError; HTTP
 * errors are returned.
 */
export async function cachedFetch(provider: string, url: string, options: CachedFetchOptions): Promise<HttpResult> {
  const method = options.method ?? 'GET'
  const mode = options.cache ?? 'default'
  const key = createHash('sha256').update(`${provider}\n${method}\n${url}\n${options.body ?? ''}`).digest('hex')

  if (mode === 'default') {
    const [row] = await db.select({ status: httpCache.status, body: httpCache.body }).from(httpCache)
      .where(and(eq(httpCache.key, key), gt(httpCache.expiresAt, new Date())))
    if (row) return { ...parse(row.status, row.body), cached: true }
  }

  const retries = options.retries ?? 3
  for (let attempt = 0; ; attempt++) {
    if (options.rateLimitKey && options.rateLimitMs && rateLimitsEnabled) await rateLimit(options.rateLimitKey, options.rateLimitMs)
    const response = await request(provider, url, {
      method,
      headers: options.headers,
      body: options.body,
      timeoutMs: options.timeoutMs,
    })
    const result: HttpResult = { ...parse(response.status, await readBody(provider, response)), cached: false }
    const kind = options.classify?.(result) ?? classifyStatus(result.status, options.cacheErrors)

    if (kind === 'retry') {
      if (attempt >= retries) return result
      await sleep(retryDelay(response.headers.get('retry-after'), attempt))
      continue
    }
    if (mode !== 'no-store' && (kind === 'ok' || kind === 'miss')) {
      const ttl = kind === 'ok' ? options.ttlSeconds : Math.min(options.ttlSeconds, missTtlSeconds)
      const row = { provider, url: redact(url), status: result.status, body: result.text, fetchedAt: new Date(), expiresAt: new Date(Date.now() + ttl * 1000) }
      await db.insert(httpCache).values({ key, ...row }).onConflictDoUpdate({ target: httpCache.key, set: row })
    }
    return result
  }
}

function classifyStatus(status: number, cacheErrors = false): ResponseKind {
  if (status >= 200 && status < 300) return 'ok'
  if (status === 429 || status === 503) return 'retry'
  if (status === 404 || status === 410) return 'miss'
  if (status >= 400 && status < 500 && cacheErrors) return 'miss'
  return 'error'
}

function parse(status: number, text: string): Omit<HttpResult, 'cached'> {
  const first = text.trimStart()[0]
  if (first !== '{' && first !== '[') return { status, text }
  try {
    return { status, json: JSON.parse(text), text }
  } catch {
    return { status, text }
  }
}

/** Retry-After in seconds or as an HTTP date, else exponential backoff from one second. */
function retryDelay(retryAfter: string | null, attempt: number): number {
  let wait = 1000 * 2 ** attempt
  if (retryAfter) {
    const seconds = Number(retryAfter)
    const date = Date.parse(retryAfter)
    if (Number.isFinite(seconds)) wait = seconds * 1000
    else if (Number.isFinite(date)) wait = date - Date.now()
  }
  return Math.min(Math.max(wait, 0), maxRetryWaitMs)
}

function redact(url: string): string {
  const parsed = new URL(url)
  for (const name of [...parsed.searchParams.keys()]) {
    if (secretParams.has(name)) parsed.searchParams.set(name, 'redacted')
  }
  return parsed.toString()
}
