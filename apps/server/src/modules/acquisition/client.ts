/**
 * The server's side of the provider protocol (docs/provider-protocol.md). Every call has a
 * timeout, sends the provider's secret as a bearer token, follows redirects only within the
 * provider's own origin, reads at most a few megabytes, and validates the answer with its
 * contract schema. Anything else is a `ProviderCallError`, which callers turn into a job
 * failure or a provider's `last_error`; nothing a provider sends can throw anything else.
 */
import {
  ProviderAcquireResponse, ProviderCapabilities, ProviderJobStatus, ProviderResolveResponse,
  type ProviderAcquireRequest, type ProviderResolveRequest,
} from '@squirmy/contracts'
import type { z } from 'zod'
import { AppError } from '../../lib/errors.js'
import { userAgent } from '../../lib/http.js'

/** A provider could not be reached or answered something unusable. */
export class ProviderCallError extends AppError {
  constructor(message: string) {
    super(502, 'provider_unavailable', message)
    this.name = 'ProviderCallError'
  }
}

/** Where to reach a provider and how to sign in to it. */
export type ProviderEndpoint = { baseUrl: string; secret: string }

const maxBodyBytes = 4 * 1024 * 1024
const maxRedirects = 3
const timeouts = { capabilities: 10_000, resolve: 15_000, acquire: 15_000, status: 10_000 }

/** Overrides the per-call timeouts (milliseconds) in tests. */
export function configureProviderTimeouts(options: Partial<typeof timeouts>) {
  Object.assign(timeouts, options)
}

/** Joins a provider-relative path onto the base URL, keeping any path the base has. */
function urlFor(baseUrl: string, path: string): URL {
  const base = new URL(baseUrl)
  base.pathname = `${base.pathname.replace(/\/+$/, '')}${path}`
  return base
}

async function readLimited(response: Response): Promise<string> {
  if (!response.body) return ''
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of response.body) {
    bytes += chunk.byteLength
    if (bytes > maxBodyBytes) throw new ProviderCallError(`The response is larger than ${maxBodyBytes} bytes`)
    chunks.push(Buffer.from(chunk))
  }
  return Buffer.concat(chunks).toString('utf8')
}

async function call<Schema extends z.ZodType>(
  endpoint: ProviderEndpoint,
  path: string,
  schema: Schema,
  options: { method: 'GET' | 'POST'; body?: unknown; timeoutMs: number },
): Promise<z.infer<Schema>> {
  let url = urlFor(endpoint.baseUrl, path)
  const origin = url.origin
  const signal = AbortSignal.timeout(options.timeoutMs)
  try {
    for (let hop = 0; ; hop += 1) {
      const response = await fetch(url, {
        method: options.method,
        redirect: 'manual',
        signal,
        headers: {
          authorization: `Bearer ${endpoint.secret}`,
          accept: 'application/json',
          'user-agent': userAgent(),
          ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
      })
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel()
        const location = response.headers.get('location')
        const next = location ? new URL(location, url) : null
        if (!next || next.origin !== origin) throw new ProviderCallError('The provider redirected to another host')
        if (hop >= maxRedirects) throw new ProviderCallError('The provider redirected too many times')
        url = next
        continue
      }
      const text = await readLimited(response)
      if (response.status === 401 || response.status === 403) throw new ProviderCallError('The provider refused the shared secret')
      if (!response.ok) throw new ProviderCallError(`HTTP ${response.status} from ${path}: ${text.slice(0, 200)}`)
      let json: unknown
      try {
        json = JSON.parse(text)
      } catch {
        throw new ProviderCallError(`${path} did not answer with JSON`)
      }
      const parsed = schema.safeParse(json)
      if (!parsed.success) throw new ProviderCallError(`${path} answered with an unexpected shape: ${parsed.error.issues[0]?.message ?? 'invalid'}`)
      return parsed.data
    }
  } catch (error) {
    if (error instanceof ProviderCallError) throw error
    if (signal.aborted) throw new ProviderCallError(`${path} did not answer within ${options.timeoutMs / 1000} seconds`)
    throw new ProviderCallError(`Could not reach the provider: ${(error as Error).message}`)
  }
}

/** `GET /capabilities`. */
export function fetchCapabilities(endpoint: ProviderEndpoint): Promise<ProviderCapabilities> {
  return call(endpoint, '/capabilities', ProviderCapabilities, { method: 'GET', timeoutMs: timeouts.capabilities })
}

/** `POST /resolve` with up to 100 items. */
export function resolveItems(endpoint: ProviderEndpoint, request: ProviderResolveRequest): Promise<ProviderResolveResponse> {
  return call(endpoint, '/resolve', ProviderResolveResponse, { method: 'POST', body: request, timeoutMs: timeouts.resolve })
}

/** `POST /acquire`. */
export function acquire(endpoint: ProviderEndpoint, request: ProviderAcquireRequest): Promise<ProviderAcquireResponse> {
  return call(endpoint, '/acquire', ProviderAcquireResponse, { method: 'POST', body: request, timeoutMs: timeouts.acquire })
}

/** `GET /jobs/{providerJobId}`. */
export function jobStatus(endpoint: ProviderEndpoint, providerJobId: string): Promise<ProviderJobStatus> {
  return call(endpoint, `/jobs/${encodeURIComponent(providerJobId)}`, ProviderJobStatus, { method: 'GET', timeoutMs: timeouts.status })
}
