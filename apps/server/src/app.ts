import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import { getConfig } from './config.js'
import { AppError } from './lib/errors.js'

/** Builds the HTTP application. It does not listen; index.ts and tests do that. */
export async function buildApp(): Promise<FastifyInstance> {
  const config = getConfig()
  const app = Fastify({
    logger: config.LOG_LEVEL === 'silent' ? false : { level: config.LOG_LEVEL },
    trustProxy: config.TRUST_PROXY,
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

  app.get('/health', async () => ({ status: 'ok', service: 'squirmy' }))

  return app
}
