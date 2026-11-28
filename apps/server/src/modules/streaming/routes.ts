import { Id, PlaybackQuery, StreamIntent, StreamProfile, type PlaybackDescriptor } from '@squirmy/contracts'
import { eq } from 'drizzle-orm'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { db } from '../../database/client.js'
import { mediaFiles } from '../../database/schema.js'
import { requireUser } from '../../lib/auth.js'
import { forbidden, notFound, unauthorized } from '../../lib/errors.js'
import { measureOnPlay } from '../loudness/index.js'
import { streamSignal } from './files.js'
import { buildPlaybackDescriptor, verifyStreamSignature } from './playback.js'
import { openStream } from './stream.js'

const TrackParams = z.object({ id: Id })
const StreamParams = z.object({ fileId: Id, profile: StreamProfile.default('original') })
const StreamQuery = z.object({
  exp: z.string().optional(),
  uid: z.string().optional(),
  sig: z.string().optional(),
  download: z.stringbool().optional(),
  intent: StreamIntent.default('play'),
})

/** A valid signature for this file and profile, or else a signed-in session. */
async function authorizeStream(request: FastifyRequest, fileId: string, profile: StreamProfile, query: z.infer<typeof StreamQuery>) {
  const signedUser = query.sig ? await verifyStreamSignature(fileId, profile, query) : null
  if (signedUser) return signedUser
  if (request.user) return request.user.id
  throw query.sig ? forbidden('This link is invalid or has expired', 'invalid_signature') : unauthorized()
}

async function stream(request: FastifyRequest, reply: FastifyReply) {
  const params = StreamParams.safeParse(request.params)
  if (!params.success) throw notFound()
  const { fileId, profile } = params.data
  const query = StreamQuery.parse(request.query)
  const userId = await authorizeStream(request, fileId, profile, query)
  const [file] = await db.select().from(mediaFiles).where(eq(mediaFiles.id, fileId))
  if (!file) throw notFound('No such file', 'not_available')
  const response = await openStream(file, profile, {
    range: request.headers.range,
    ifRange: [request.headers['if-range']].flat()[0],
    head: request.method === 'HEAD',
    download: query.download === true,
    intent: query.intent,
    userId,
    signal: profile === 'original' ? undefined : streamSignal(reply.raw),
  })
  if (response.body && !query.download) {
    void measureOnPlay(file).catch((error: unknown) => request.log.warn({ err: error, fileId }, 'Could not queue loudness measurement'))
  }
  reply.code(response.status).headers(response.headers)
  return reply.send(response.body ?? undefined)
}

export async function streamingRoutes(app: FastifyInstance) {
  app.get('/tracks/:id/playback', async (request): Promise<PlaybackDescriptor> => {
    const user = requireUser(request)
    const { id } = TrackParams.parse(request.params)
    return buildPlaybackDescriptor(user.id, id, PlaybackQuery.parse(request.query))
  })

  app.route({ method: ['GET', 'HEAD'], url: '/stream/:fileId', handler: stream })
  app.route({ method: ['GET', 'HEAD'], url: '/stream/:fileId/:profile', handler: stream })
}
