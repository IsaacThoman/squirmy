import { Id, type TrackSonic } from '@squirmy/contracts'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { requireUser } from '../../lib/auth.js'
import { trackSonic } from './profile.js'

const IdParams = z.object({ id: Id })

export async function sonicRoutes(app: FastifyInstance) {
  app.get('/tracks/:id/sonic', async (request): Promise<TrackSonic> => {
    requireUser(request)
    return trackSonic(IdParams.parse(request.params).id)
  })
}
