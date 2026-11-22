import type { FastifyRequest, FastifyServerOptions } from 'fastify'

/**
 * Query parameters that carry credentials: Subsonic `p` (an app password, clear or `enc:`
 * hex), `apiKey`, the `t`/`s` token pair (replayable, since salts are not tracked), the
 * stream URL `sig`, and Last.fm's callback `token` and `state`.
 */
const secretParams = new Set(['p', 't', 's', 'apikey', 'sig', 'token', 'state', 'password'])

function decodedKey(raw: string): string {
  try {
    return decodeURIComponent(raw.replace(/\+/g, ' ')).toLowerCase()
  } catch {
    return raw.toLowerCase()
  }
}

/** The URL with the values of credential parameters replaced, for logs. */
export function redactUrl(url: string): string {
  // The router ends the path at the first `?` or `#` and parses the rest as the query.
  const mark = url.search(/[?#]/)
  if (mark < 0) return url
  const query = url.slice(mark + 1).split('&').map((pair) => {
    const equals = pair.indexOf('=')
    const key = equals < 0 ? pair : pair.slice(0, equals)
    return secretParams.has(decodedKey(key)) ? `${key}=[redacted]` : pair
  })
  return `${url.slice(0, mark + 1)}${query.join('&')}`
}

/**
 * Fastify's logger options. The default request serializer logs the full URL, so
 * credentials passed as query parameters would land in every log line and log shipper.
 * Headers are never serialized; the redact paths cover code that logs them by hand.
 */
export function loggerOptions(level: string, stream?: { write(line: string): void }): FastifyServerOptions['logger'] {
  if (level === 'silent') return false
  return {
    level,
    stream,
    serializers: {
      req: (request: FastifyRequest) => ({
        method: request.method,
        url: redactUrl(request.url),
        version: request.headers?.['accept-version'] as string | undefined,
        host: request.host,
        remoteAddress: request.ip,
        remotePort: request.socket?.remotePort,
      }),
    },
    redact: {
      paths: ['req.headers.authorization', 'req.headers.cookie', 'headers.authorization', 'headers.cookie', 'res.headers["set-cookie"]'],
      censor: '[redacted]',
    },
  }
}
