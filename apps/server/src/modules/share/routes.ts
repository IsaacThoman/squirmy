import {
  CreateShareRequest, Id, PageQuery, ShareTrackQuery,
  type Ok, type PublicShare, type ShareLink, type ShareLinkPage, type ShareTrackPlayback,
} from '@squirmy/contracts'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { requireAdmin, requireUser } from '../../lib/auth.js'
import { AppError } from '../../lib/errors.js'
import { addressKey } from '../../lib/proxy.js'
import { openStream, streamSignal } from '../streaming/index.js'
import { createShare, listShares, recordOpen, revokeShare, shareForToken, shareNotFound } from './links.js'
import { publicShare } from './page.js'
import { authorizeShareStream, shareTrackPlayback } from './playback.js'
import { servePreview } from './preview.js'

const IdParams = z.object({ id: Id })
const TokenParams = z.object({ token: z.string().max(200) })
const TrackParams = TokenParams.extend({ id: Id })
// In the query: a sealed key is longer than the 100 characters Fastify allows a path parameter.
const StreamQuery = z.object({ key: z.string().min(1).max(1000) })

/**
 * Per-minute limits per address for the routes anyone can call. The page and the song URLs are
 * a token lookup each, so they are kept to what a person clicking through a page needs; the
 * stream route takes many Range requests per song, and its keys are sealed anyway.
 */
export const SHARE_RATE_LIMITS = { page: 60, playback: 120, stream: 600 } as const

function limiter(app: FastifyInstance, name: keyof typeof SHARE_RATE_LIMITS) {
  const check = app.createRateLimit({ max: SHARE_RATE_LIMITS[name], timeWindow: 60_000, keyGenerator: (request) => `share-${name}:${addressKey(request.ip)}` })
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const result = await check(request)
    if (result.isAllowed || !result.isExceeded) return
    reply.header('retry-after', result.ttlInSeconds)
    throw new AppError(429, 'rate_limited', `Too many requests. Try again in ${result.ttlInSeconds} seconds.`)
  }
}

/** A malformed token or key answers the same 404 as an unknown one. */
function parseOr404<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  const parsed = schema.safeParse(value)
  if (!parsed.success) throw shareNotFound()
  return parsed.data
}

export async function shareRoutes(app: FastifyInstance) {
  const pageLimit = limiter(app, 'page')
  const playbackLimit = limiter(app, 'playback')
  const streamLimit = limiter(app, 'stream')

  app.get('/me/shares', async (request): Promise<ShareLinkPage> => {
    const user = requireUser(request)
    return listShares(user.id, PageQuery.parse(request.query), { all: false })
  })

  app.post('/me/shares', async (request): Promise<ShareLink> => {
    const user = requireUser(request)
    return createShare(user.id, CreateShareRequest.parse(request.body))
  })

  app.delete('/me/shares/:id', async (request): Promise<Ok> => {
    const user = requireUser(request)
    await revokeShare(IdParams.parse(request.params).id, user.id)
    return { ok: true }
  })

  app.get('/admin/shares', async (request): Promise<ShareLinkPage> => {
    const admin = requireAdmin(request)
    return listShares(admin.id, PageQuery.parse(request.query), { all: true })
  })

  app.delete('/admin/shares/:id', async (request): Promise<Ok> => {
    requireAdmin(request)
    await revokeShare(IdParams.parse(request.params).id, null)
    return { ok: true }
  })

  // No session: anyone with the link. A signed-in visitor gets the same answer as anyone else.
  app.get('/share/:token', { preHandler: pageLimit }, async (request): Promise<PublicShare> => {
    const share = await shareForToken(parseOr404(TokenParams, request.params).token)
    const page = await publicShare(share)
    await recordOpen(share.id)
    return page
  })

  app.get('/share/:token/tracks/:id/playback', { preHandler: playbackLimit }, async (request): Promise<ShareTrackPlayback> => {
    const { token, id } = parseOr404(TrackParams, request.params)
    const share = await shareForToken(token)
    return shareTrackPlayback(share, id, ShareTrackQuery.parse(request.query).codecs)
  })

  app.route({
    method: ['GET', 'HEAD'],
    url: '/share/stream',
    preHandler: streamLimit,
    handler: async (request, reply) => {
      const { share, file, profile } = await authorizeShareStream(parseOr404(StreamQuery, request.query).key)
      const streamRequest = {
        range: request.headers.range,
        ifRange: [request.headers['if-range']].flat()[0],
        head: request.method === 'HEAD',
        intent: 'play' as const,
        // Listeners of one link share the per-user encoder allowance, so a popular link cannot take every encoder.
        userId: `share:${share.id}`,
      }
      const response = profile === 'preview'
        ? await servePreview(file, streamRequest)
        : await openStream(file, profile, { ...streamRequest, signal: profile === 'original' ? undefined : streamSignal(reply.raw) })
      reply.code(response.status).headers(response.headers)
      return reply.send(response.body ?? undefined)
    },
  })
}
