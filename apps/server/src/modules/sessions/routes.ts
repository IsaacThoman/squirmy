import { PlaybackControl, type DeviceInfo, type JamPerson, type JamPreview, type SessionSnapshot } from '@squirmy/contracts'
import type { FastifyInstance } from 'fastify'
import { requireUser } from '../../lib/auth.js'
import { sessionDevice } from '../auth/service.js'
import { controlPlayback, getDevices, getJamPreview, getSnapshot, jamPeople } from './service.js'

export async function sessionRoutes(app: FastifyInstance) {
  app.get('/me/session', async (request): Promise<SessionSnapshot> => getSnapshot(requireUser(request).id))

  app.post('/me/session/command', async (request): Promise<SessionSnapshot> =>
    controlPlayback(requireUser(request).id, PlaybackControl.parse(request.body)))

  app.get('/me/devices', async (request): Promise<{ items: DeviceInfo[]; nextCursor: null }> => {
    const user = requireUser(request)
    const current = request.authSessionId ? await sessionDevice(request.authSessionId) : null
    return { items: await getDevices(user.id, current), nextCursor: null }
  })

  // Registered before `/jams/:id`, which would otherwise take "people" for an id.
  app.get('/jams/people', async (request): Promise<{ items: JamPerson[]; nextCursor: null }> => (
    { items: await jamPeople(requireUser(request).id), nextCursor: null }
  ))

  app.get<{ Params: { id: string } }>('/jams/:id', async (request): Promise<JamPreview> => {
    requireUser(request)
    return getJamPreview(request.params.id)
  })
}
