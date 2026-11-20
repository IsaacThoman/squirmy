import type { ServerModule } from '../types.js'
import { sessionRoutes } from './routes.js'
import { stopSessions } from './service.js'
import { registerSessionSockets } from './socket.js'

export { getSnapshot, markRecordingFailed, markRecordingReady, recordExternalPlay, replaceQueue } from './service.js'

/**
 * Playback sessions: one per user, held in the API process's memory, changed by
 * `session:command` and broadcast to the user's sockets. See docs/architecture.md, "Sessions".
 */
export const sessionsModule: ServerModule = {
  name: 'sessions',
  routes: sessionRoutes,
  realtime: registerSessionSockets,
  stop: stopSessions,
}
