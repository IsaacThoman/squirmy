/**
 * The provider side of docs/provider-protocol.md, for writing an acquisition provider in a
 * few lines: an HTTP server that checks the shared secret, validates every request with the
 * contract schemas, keeps acquire jobs idempotent by the server's job id, and delivers the
 * files a job produces to the server's upload URL before posting completion.
 *
 * The provider supplies `resolve` (what it can offer for an item) and `fetch` (the files for
 * an offer it made). Nothing else is needed.
 */
import { timingSafeEqual } from 'node:crypto'
import { openAsBlob } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import {
  PROVIDER_PROTOCOL_VERSION, ProviderAcquireRequest, ProviderResolveRequest,
  type ProviderAcquireResponse, type ProviderCapabilities, type ProviderJobStatus, type ProviderOffer, type ProviderResolveItem,
  type ProviderResolveResponse,
} from '@squirmy/contracts'

export { PROVIDER_PROTOCOL_VERSION }

/** One file to deliver: where it is on disk, and the path it gets inside the server's import. */
export type DeliveryFile = { path: string; name: string }

export type ProviderOptions = {
  /** The shared secret the server sends as a bearer token. */
  secret: string
  capabilities: Omit<ProviderCapabilities, 'protocol'>
  /** Offers for one requested item; an empty list means it cannot be supplied. */
  resolve: (item: ProviderResolveItem) => Promise<ProviderOffer[]> | ProviderOffer[]
  /**
   * The files for an offer this provider made. Throw to fail the job. Called once per job;
   * `cleanup` runs after the files were delivered (or the job failed). `signal` aborts when
   * the server closes.
   */
  fetch: (offerId: string, job: { jobId: string; signal: AbortSignal }) => Promise<{ files: DeliveryFile[]; cleanup?: () => Promise<void> }>
  /** Called with errors from background deliveries. Defaults to `console.error`. */
  onError?: (error: unknown) => void
}

export type ProviderJob = {
  jobId: string
  offerId: string
  status: ProviderJobStatus['status']
  error: string | null
  /** The latest delivery the server sent: a repeated acquire carries a fresh token. */
  delivery: ProviderAcquireRequest['delivery']
  done: Promise<void>
}

export type ProviderServer = {
  server: Server
  /** Jobs by the server's job id. */
  jobs: Map<string, ProviderJob>
  /** Starts listening and returns the base URL. Port 0 picks a free port. */
  listen: (port?: number, host?: string) => Promise<string>
  close: () => Promise<void>
}

const maxBodyBytes = 1024 * 1024

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
  }
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of request) {
    bytes += (chunk as Buffer).length
    if (bytes > maxBodyBytes) throw new HttpError(413, 'Request body too large')
    chunks.push(chunk as Buffer)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new HttpError(400, 'The body is not JSON')
  }
}

function send(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(JSON.stringify(body))
}

function authorized(request: IncomingMessage, secret: string): boolean {
  const header = request.headers.authorization ?? ''
  const given = Buffer.from(header.startsWith('Bearer ') ? header.slice(7) : '')
  const expected = Buffer.from(secret)
  return given.length === expected.length && timingSafeEqual(given, expected)
}

/** Posts JSON or a body to one of the server's delivery URLs with the job's token. */
async function post(url: string, token: string, body: FormData | string) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, ...(typeof body === 'string' ? { 'content-type': 'application/json' } : {}) },
    body,
  })
  const text = await response.text()
  if (!response.ok) throw new Error(`The server answered ${response.status} to ${url}: ${text.slice(0, 300)}`)
}

/**
 * Uploads files to a job's delivery, one request per file (streamed from disk), then posts
 * completion. Reads `job.delivery` before each request, so a fresh token from a repeated
 * acquire is used from then on.
 */
export async function deliver(job: Pick<ProviderJob, 'delivery'>, files: readonly DeliveryFile[]) {
  for (const file of files) {
    const form = new FormData()
    form.append('relativePath', file.name)
    form.append('file', await openAsBlob(file.path), file.name.split('/').at(-1))
    await post(job.delivery.uploadUrl, job.delivery.token, form)
  }
  await post(job.delivery.completeUrl, job.delivery.token, JSON.stringify({ status: 'completed' }))
}

/** Tells the server a job failed. */
export async function reportFailure(job: Pick<ProviderJob, 'delivery'>, error: string) {
  await post(job.delivery.completeUrl, job.delivery.token, JSON.stringify({ status: 'failed', error }))
}

/** Creates a provider HTTP server. It does not listen until `listen` is called. */
export function createProviderServer(options: ProviderOptions): ProviderServer {
  const jobs = new Map<string, ProviderJob>()
  const closing = new AbortController()
  const onError = options.onError ?? ((error: unknown) => console.error('[provider]', error))

  async function run(job: ProviderJob) {
    let fetched: Awaited<ReturnType<ProviderOptions['fetch']>> | undefined
    try {
      job.status = 'running'
      fetched = await options.fetch(job.offerId, { jobId: job.jobId, signal: closing.signal })
      closing.signal.throwIfAborted()
      await deliver(job, fetched.files)
      job.status = 'completed'
    } catch (error) {
      job.status = 'failed'
      job.error = error instanceof Error ? error.message : String(error)
      if (!closing.signal.aborted) await reportFailure(job, job.error).catch(onError)
    } finally {
      await fetched?.cleanup?.().catch(onError)
    }
  }

  async function handle(request: IncomingMessage, response: ServerResponse) {
    const url = new URL(request.url ?? '/', 'http://provider')
    if (!authorized(request, options.secret)) throw new HttpError(401, 'Unauthorized')
    if (request.method === 'GET' && url.pathname === '/capabilities') {
      return send(response, 200, { protocol: PROVIDER_PROTOCOL_VERSION, ...options.capabilities } satisfies ProviderCapabilities)
    }
    if (request.method === 'POST' && url.pathname === '/resolve') {
      const parsed = ProviderResolveRequest.safeParse(await readJson(request))
      if (!parsed.success) throw new HttpError(400, parsed.error.issues[0]?.message ?? 'Invalid request')
      const items = await Promise.all(parsed.data.items.map(async (item) => ({ ref: item.ref, offers: await options.resolve(item) })))
      return send(response, 200, { items } satisfies ProviderResolveResponse)
    }
    if (request.method === 'POST' && url.pathname === '/acquire') {
      const parsed = ProviderAcquireRequest.safeParse(await readJson(request))
      if (!parsed.success) throw new HttpError(400, parsed.error.issues[0]?.message ?? 'Invalid request')
      const { jobId, offerId, delivery } = parsed.data
      const known = jobs.get(jobId)
      if (known) {
        // The same job again: keep the work, use the newest delivery details.
        known.delivery = delivery
        return send(response, 200, { accepted: true, providerJobId: jobId } satisfies ProviderAcquireResponse)
      }
      const job: ProviderJob = { jobId, offerId, status: 'queued', error: null, delivery, done: Promise.resolve() }
      jobs.set(jobId, job)
      job.done = run(job)
      return send(response, 200, { accepted: true, providerJobId: jobId } satisfies ProviderAcquireResponse)
    }
    const status = request.method === 'GET' ? /^\/jobs\/([^/]+)$/.exec(url.pathname) : null
    if (status) {
      const job = jobs.get(decodeURIComponent(status[1]!))
      if (!job) throw new HttpError(404, 'No such job')
      return send(response, 200, { status: job.status, error: job.error } satisfies ProviderJobStatus)
    }
    throw new HttpError(404, 'Not found')
  }

  const server = createServer((request, response) => {
    handle(request, response).catch((error: unknown) => {
      if (error instanceof HttpError) return send(response, error.status, { error: error.message })
      onError(error)
      send(response, 500, { error: 'Internal error' })
    })
  })

  return {
    server,
    jobs,
    listen: (port = 0, host = '127.0.0.1') => new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(port, host, () => {
        const address = server.address() as AddressInfo
        const shown = address.family === 'IPv6' ? `[${address.address}]` : address.address
        resolve(`http://${shown === '0.0.0.0' ? '127.0.0.1' : shown}:${address.port}`)
      })
    }),
    close: async () => {
      closing.abort()
      const closed = new Promise<void>((resolve) => server.close(() => resolve()))
      server.closeAllConnections()
      await closed
      await Promise.allSettled([...jobs.values()].map((job) => job.done))
    },
  }
}

/** Lowercase, no diacritics, punctuation as spaces, single spaces: for comparing titles and names. */
export function textKey(text: string): string {
  return text.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/&/g, ' and ').replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
}

// Words that describe an edition rather than different music: a bracketed or dashed suffix
// made only of these (and numbers), with at least one strong word, is not part of the title.
// "(Live)", "(Remix)" or "(Mono)" stay.
const strongEditionWords = new Set([
  'deluxe', 'expanded', 'special', 'anniversary', 'remaster', 'remastered', 'remasters', 'explicit', 'clean', 'edited',
  'bonus', 'collectors', 'limited', 'legacy', 'reissue', 'standard',
])
const weakEditionWords = new Set(['super', 'edition', 'version', 'track', 'tracks', 'digital', 'the', 'and'])
const ordinal = /^\d+(st|nd|rd|th)?$/
const suffixes = [/\s*\(([^()]*)\)\s*$/, /\s*\[([^[\]]*)\]\s*$/, /\s+[-–—]\s+([^-–—()[\]]+)$/]

function isEdition(text: string): boolean {
  const words = textKey(text).split(' ').filter(Boolean)
  if (['feat', 'ft', 'featuring'].includes(words[0] ?? '')) return true
  return words.some((word) => strongEditionWords.has(word))
    && words.every((word) => strongEditionWords.has(word) || weakEditionWords.has(word) || ordinal.test(word))
}

/**
 * `textKey` of a title without trailing edition qualifiers and guest credits, so
 * "Something (Remastered 2009)" and "Something" compare equal, and "Song (Live)" does not.
 */
export function titleKey(title: string): string {
  let current = title.trim()
  for (;;) {
    const match = suffixes.map((pattern) => pattern.exec(current)).find((found) => found && isEdition(found[1]!))
    if (!match || !textKey(current.slice(0, match.index))) return textKey(current)
    current = current.slice(0, match.index).trim()
  }
}
