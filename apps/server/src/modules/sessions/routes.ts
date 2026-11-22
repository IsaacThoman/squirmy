import type { DeviceInfo, SessionSnapshot } from '@squirmy/contracts'
import type { FastifyInstance } from 'fastify'
import { requireUser } from '../../lib/auth.js'
import { sessionDevice } from '../auth/service.js'
import { getDevices, getSnapshot } from './service.js'

export async function sessionRoutes(app: FastifyInstance) {
  app.get('/me/session', async (request): Promise<SessionSnapshot> => getSnapshot(requireUser(request).id))

  app.get('/me/devices', async (request): Promise<{ items: DeviceInfo[]; nextCursor: null }> => {
    const user = requireUser(request)
    const current = request.authSessionId ? await sessionDevice(request.authSessionId) : null
    return { items: await getDevices(user.id, current), nextCursor: null }
  })
}
