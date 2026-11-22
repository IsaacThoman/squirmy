/**
 * Conditional GETs for the native API's JSON reads.
 *
 * Every successful GET under `/api/v1` that answers JSON gets a weak ETag (a hash of the
 * body) and `Cache-Control: private, no-cache`: clients and browsers may keep the body
 * but must ask again each time, and when nothing changed the answer is an empty 304
 * instead of the whole document. Weak because the body may be compressed on the way.
 * Routes that set their own `Cache-Control` or `ETag` (art, streams) are left alone.
 */
import { createHash } from 'node:crypto'
import { API_PREFIX } from '@squirmy/contracts'
import type { FastifyReply, FastifyRequest } from 'fastify'

/** `W/"<hash>"` of a response body. */
export function weakEtag(body: string | Buffer): string {
  return `W/"${createHash('sha1').update(body).digest('base64url').slice(0, 22)}"`
}

/**
 * Whether an `If-None-Match` header names this ETag, compared weakly (RFC 9110): `W/`
 * prefixes are ignored, a list matches when any entry does, and `*` matches anything.
 * Proxies such as Cloudflare weaken ETags they pass on, so clients send `W/` back even
 * for ETags the server sent strong.
 */
export function etagMatches(header: string | string[] | undefined, etag: string): boolean {
  if (!header) return false
  const opaque = (tag: string) => tag.trim().replace(/^W\//, '')
  const wanted = opaque(etag)
  return [header].flat().join(',').split(',').some((tag) => tag.trim() === '*' || opaque(tag) === wanted)
}

export const revalidate = 'private, no-cache'

const isJson = (type: unknown) => typeof type === 'string' && type.startsWith('application/json')

/** onSend hook: adds the validators and answers 304 when the client already has this body. */
export async function conditionalGet(request: FastifyRequest, reply: FastifyReply, payload: unknown) {
  if (request.method !== 'GET' && request.method !== 'HEAD') return payload
  if (reply.statusCode !== 200 || !request.url.startsWith(`${API_PREFIX}/`)) return payload
  if (typeof payload !== 'string' && !Buffer.isBuffer(payload)) return payload
  if (!isJson(reply.getHeader('content-type')) || reply.hasHeader('cache-control')) return payload
  const etag = (reply.getHeader('etag') as string | undefined) ?? weakEtag(payload)
  reply.header('etag', etag).header('cache-control', revalidate)
  if (etagMatches(request.headers['if-none-match'], etag)) {
    reply.code(304)
    return ''
  }
  return payload
}
