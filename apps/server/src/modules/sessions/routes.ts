import { PlaybackControl, type DeviceInfo, type SessionSnapshot } from '@squirmy/contracts'
import type { FastifyInstance } from 'fastify'
import { requireUser } from '../../lib/auth.js'
import { sessionDevice } from '../auth/service.js'
import { controlPlayback, getDevices, getSnapshot } from './service.js'

export async function sessionRoutes(app: FastifyInstance) {
  app.get('/me/session', async (request): Promise<SessionSnapshot> => getSnapshot(requireUser(request).id))

  app.post('/me/session/command', async (request): Promise<SessionSnapshot> =>
    controlPlayback(requireUser(request).id, PlaybackControl.parse(request.body)))

  app.get('/me/devices', async (request): Promise<{ items: DeviceInfo[]; nextCursor: null }> => {
    const user = requireUser(request)
    const current = request.authSessionId ? await sessionDevice(request.authSessionId) : null
    return { items: await getDevices(user.id, current), nextCursor: null }
  })
}
