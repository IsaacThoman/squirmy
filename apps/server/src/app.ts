import path from 'node:path'
import compress from '@fastify/compress'
import cookie from '@fastify/cookie'
import cors from '@fastify/cors'
import helmet from '@fastify/helmet'
import multipart from '@fastify/multipart'
import rateLimit from '@fastify/rate-limit'
import fastifyStatic from '@fastify/static'
import { API_PREFIX } from '@squirmy/contracts'
import { sql } from 'drizzle-orm'
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify'
import { ZodError } from 'zod'
import { devOrigins, getConfig } from './config.js'
import { db } from './database/client.js'
import { SESSION_COOKIE } from './lib/auth.js'
import { conditionalGet } from './lib/conditional.js'
import { AppError, forbidden } from './lib/errors.js'
import { loggerOptions } from './lib/log.js'
import { headerAddress, trustFunction } from './lib/proxy.js'
import { modules } from './modules/index.js'
import { authenticateApiToken, authenticateToken } from './modules/auth/service.js'
import { allowedApiToken } from './modules/auth/scopes.js'

/** Paths the web app's SPA fallback must never answer. */
const reservedPrefixes = ['/api', '/rest', '/socket.io', '/health', '/ready']
const isReserved = (url: string) => reservedPrefixes.some((prefix) => url === prefix || url.startsWith(`${prefix}/`) || url.startsWith(`${prefix}?`))
const safeMethods = new Set(['GET', 'HEAD', 'OPTIONS'])
const compressibleTypes = /^(?:text\/(?!event-stream)|application\/(?:json|javascript|xml|manifest\+json)|image\/svg\+xml)/

function bearerToken(request: FastifyRequest) {
  const header = request.headers.authorization
  return header?.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() || undefined : undefined
}

/** Builds the HTTP application. It does not listen; index.ts and tests do that. */
export async function buildApp(options: { logStream?: { write(line: string): void } } = {}): Promise<FastifyInstance> {
  const config = getConfig()
  const trust = trustFunction(config.TRUST_PROXY)
  const app = Fastify({
    logger: loggerOptions(options.logStream ? 'info' : config.LOG_LEVEL, options.logStream),
    trustProxy: trust,
    // Uploads stream to disk; this only bounds JSON bodies.
    bodyLimit: 4 * 1024 * 1024,
  })

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof AppError) {
      return reply.code(error.status).send({ error: { code: error.code, message: error.message, details: error.details } })
    }
    if (error instanceof ZodError) {
      return reply.code(400).send({ error: { code: 'invalid_request', message: 'The request is not valid', details: error.issues } })
    }
    const status = typeof (error as { statusCode?: unknown }).statusCode === 'number' ? (error as { statusCode: number }).statusCode : 500
    if (status >= 500) request.log.error({ err: error }, 'Unhandled error')
    const message = status >= 500 ? 'Something went wrong' : (error as Error).message
    return reply.code(status).send({ error: { code: status >= 500 ? 'internal_error' : 'request_error', message } })
  })

  // The web app loads only its own files: no inline scripts (the appearance script is a file of
  // its own), so script-src is 'self'. Inline styles stay allowed for `style=` and the theme's
  // <style> element. Media may also come from blob: URLs, which is how an <audio> element is
  // given a MediaSource the page fills itself. No upgrade-insecure-requests, so the app keeps
  // working over plain HTTP on a LAN. Artwork and streams are also loaded by Subsonic web clients
  // on other origins, which the default same-origin CORP blocks.
  await app.register(helmet, {
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:'],
        mediaSrc: ["'self'", 'blob:'],
        connectSrc: ["'self'"],
        fontSrc: ["'self'", 'data:'],
        workerSrc: ["'none'"],
        objectSrc: ["'none'"],
        baseUri: ["'none'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
      },
    },
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  })
  // Before compression, so the ETag describes the body and a 304 has nothing to compress.
  app.addHook('onSend', conditionalGet)
  // Brotli (quality 4, fast enough to run per response) or gzip for JSON, Subsonic XML and
  // the web app's text files. Audio, images and anything with a Range are sent as they are.
  await app.register(compress, { encodings: ['br', 'gzip'], threshold: 1024, customTypes: compressibleTypes })
  await app.register(cookie)
  await app.register(cors, {
    origin: config.devCors ? devOrigins : false,
    credentials: true,
  })
  // Opt-in per route: login, setup, register, password changes and provider deliveries. Counters are per process.
  // A larger store than the default 5000 keys, so a flood of new keys cannot evict the
  // counters of the addresses it is attacking.
  await app.register(rateLimit, { global: false, cache: 50_000 })
  await app.register(multipart, { limits: { fileSize: 16 * 1024 ** 3 } })

  if (config.CLIENT_IP_HEADER) {
    const header = config.CLIENT_IP_HEADER
    // First hook, so every limiter and session record sees the same address. (Fastify's
    // "incoming request" line is written before hooks run and shows the proxy's.)
    // Fastify defines `ip` as a getter on the prototype; an own property shadows it.
    app.addHook('onRequest', async (request) => {
      const address = headerAddress(request.headers[header], request.raw.socket?.remoteAddress, trust)
      if (address) Object.defineProperty(request, 'ip', { value: address, enumerable: true })
    })
  }

  app.decorateRequest('user', null)
  app.decorateRequest('authSessionId', null)
  app.decorateRequest('viaCookie', false)

  // Native routes only: /rest authenticates each request with Subsonic credentials, and
  // static files need no session.
  app.addHook('onRequest', async (request) => {
    if (!request.url.startsWith(`${API_PREFIX}/`)) return
    const bearer = bearerToken(request)
    if (bearer?.startsWith('sq_')) {
      const token = await authenticateApiToken(bearer)
      if (!token) return
      if (!allowedApiToken(request, token.scopes)) throw forbidden('This token cannot access this endpoint', 'insufficient_scope')
      request.user = token.user
      return
    }
    const token = bearer ?? request.cookies[SESSION_COOKIE]
    const session = token ? await authenticateToken(token) : null
    if (!session) return
    request.user = session.user
    request.authSessionId = session.sessionId
    request.viaCookie = !bearer
    // A cookie is sent by the browser on its own; the custom header proves the app sent it.
    if (request.viaCookie && !safeMethods.has(request.method) && request.headers['x-squirmy-request'] !== '1') {
      throw forbidden('Missing the X-Squirmy-Request header', 'csrf')
    }
  })

  app.get('/health', async () => ({ status: 'ok', service: 'squirmy' }))

  app.get('/ready', async (_request, reply) => {
    try {
      await db.execute(sql`select 1`)
      return { status: 'ready' }
    } catch (error) {
      app.log.warn({ err: error }, 'Database is not reachable')
      return reply.code(503).send({ status: 'unavailable' })
    }
  })

  for (const module of modules) {
    if (module.routes) await app.register(async (scope) => module.routes!(scope), { prefix: API_PREFIX })
    if (module.rootRoutes) await app.register(async (scope) => module.rootRoutes!(scope))
  }

  const webDist = config.SQUIRMY_WEB_DIST ? path.resolve(config.SQUIRMY_WEB_DIST) : undefined
  if (webDist) {
    await app.register(fastifyStatic, {
      root: webDist,
      // Routes are registered for the files present at boot, so unknown paths reach the
      // not-found handler below instead of a wildcard.
      wildcard: false,
      setHeaders: (response, file) => {
        const hashed = file.startsWith(path.join(webDist, 'assets') + path.sep)
        response.header('cache-control', hashed ? 'public, max-age=31536000, immutable' : 'no-cache')
      },
    })
  }

  app.setNotFoundHandler((request, reply) => {
    if (webDist && (request.method === 'GET' || request.method === 'HEAD') && !isReserved(request.url)) {
      return reply.sendFile('index.html')
    }
    return reply.code(404).send({ error: { code: 'not_found', message: 'Not found' } })
  })

  return app
}
