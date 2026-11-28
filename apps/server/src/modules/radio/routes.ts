import { Id, type RadioResponse } from '@squirmy/contracts'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { requireUser } from '../../lib/auth.js'
import { artistRadio, sonicRadio, trackRadio } from './radio.js'

const IdParams = z.object({ id: Id })

export async function radioRoutes(app: FastifyInstance) {
  app.post('/radio/track/:id', async (request): Promise<RadioResponse> =>
    trackRadio(requireUser(request).id, IdParams.parse(request.params).id))
  app.post('/radio/artist/:id', async (request): Promise<RadioResponse> =>
    artistRadio(requireUser(request).id, IdParams.parse(request.params).id))
  app.post('/radio/sonic/:id', async (request): Promise<RadioResponse> =>
    sonicRadio(requireUser(request).id, IdParams.parse(request.params).id))
}
