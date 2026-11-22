/**
 * The `/rest` router. Every method answers GET and POST (a form body, the formPost
 * extension), with or without `.view`, in XML by default or JSON(P) with `f`. Failures,
 * unknown methods included, are Subsonic errors inside a 200 response.
 */
import { getConfig } from '../../config.js'
import { AppError } from '../../lib/errors.js'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { authenticate } from './auth.js'
import { endpoints } from './endpoints.js'
import { ErrorCode, Params, SubsonicError, sent, type Payload } from './protocol.js'
import { envelope, serialize, type Format } from './serialize.js'

const formats = new Set<string>(['xml', 'json', 'jsonp'])
const callbackName = /^[A-Za-z_$][\w$.]{0,127}$/

/** Service errors become the closest Subsonic code. */
function toSubsonic(error: unknown, request: FastifyRequest): SubsonicError {
  if (error instanceof SubsonicError) return error
  if (error instanceof AppError) {
    if (error.status === 404 || error.code.endsWith('_not_found')) return new SubsonicError(ErrorCode.notFound, error.message)
    if (error.status === 403) return new SubsonicError(ErrorCode.notAuthorized, error.message)
    if (error.status < 500) return new SubsonicError(ErrorCode.generic, error.message)
  }
  request.log.error({ err: error }, 'Subsonic request failed')
  return new SubsonicError(ErrorCode.generic, 'Something went wrong')
}

function send(reply: FastifyReply, format: Format, callback: string | undefined, body: Payload) {
  const { contentType, body: text } = serialize(format, body, callback)
  return reply.code(200).type(contentType).send(text)
}

/** The origin clients reach the server at: PUBLIC_URL, else the request's own. */
function baseUrl(request: FastifyRequest): string {
  return getConfig().PUBLIC_URL?.replace(/\/+$/, '') ?? `${request.protocol}://${request.host}`
}

async function handle(request: FastifyRequest, reply: FastifyReply) {
  const params = Params.from(request.query, typeof request.body === 'object' ? request.body : undefined)
  const requested = params.string('f')?.toLowerCase()
  const format: Format = requested && formats.has(requested) ? requested as Format : 'xml'
  const callback = params.string('callback')
  if (format === 'jsonp' && !(callback && callbackName.test(callback))) {
    return send(reply, 'json', undefined, envelope('failed', { error: { code: ErrorCode.missingParameter, message: 'Required parameter is missing: callback' } }))
  }
  const method = (request.params as { '*': string })['*'].replace(/\.view$/, '')
  try {
    const endpoint = endpoints.get(method.toLowerCase())
    if (!endpoint) throw new SubsonicError(ErrorCode.generic, `Unknown API method: ${method}`)
    const user = endpoint.public ? null : await authenticate(params)
    if (endpoint.admin && user?.role !== 'admin') {
      throw new SubsonicError(ErrorCode.notAuthorized, 'User is not authorized for the given operation')
    }
    const result = await endpoint.handler({ user: user!, params, client: params.string('c') ?? 'unknown', request, reply, baseUrl: baseUrl(request) })
    if (result === sent) return reply
    return send(reply, format, callback, envelope('ok', result))
  } catch (error) {
    if (reply.sent) throw error
    const failure = toSubsonic(error, request)
    return send(reply, format, callback, envelope('failed', { error: { code: failure.code, message: failure.message } }))
  }
}

export async function subsonicRoutes(app: FastifyInstance) {
  // The formPost extension. Only this scope parses form bodies.
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_request, body, done) => {
    done(null, Object.fromEntries(groupForm(body as string)))
  })
  // Browser-based clients run on other origins; credentials travel as parameters, not
  // cookies, so any origin may call.
  app.addHook('onSend', async (_request, reply) => {
    reply.header('access-control-allow-origin', '*')
  })
  app.route({
    method: 'OPTIONS',
    url: '/rest/*',
    handler: (_request, reply) => reply.code(204)
      .header('access-control-allow-methods', 'GET, POST, HEAD, OPTIONS')
      .header('access-control-allow-headers', 'content-type, range')
      .header('access-control-max-age', '86400')
      .send(),
  })
  app.route({ method: ['GET', 'POST', 'HEAD'], url: '/rest/*', handler: handle })
}

/** Form fields with every value of a repeated name. */
function groupForm(body: string): Map<string, string[]> {
  const fields = new Map<string, string[]>()
  for (const [name, value] of new URLSearchParams(body)) {
    const list = fields.get(name) ?? []
    list.push(value)
    fields.set(name, list)
  }
  return fields
}
