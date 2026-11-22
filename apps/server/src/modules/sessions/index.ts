import type { ServerModule } from '../types.js'
import { sessionRoutes } from './routes.js'
import { stopSessions } from './service.js'
import { registerSessionSockets } from './socket.js'

export { getSnapshot, markRecordingFailed, markRecordingReady, recordExternalPlay, replaceQueue } from './service.js'
export { onPlayStart } from './plays.js'

/**
 * Playback sessions: one shared session per user, plus one of its own for each detached
 * device, held in the API process's memory, changed by `session:command` and broadcast to
 * the sockets in that session. See docs/architecture.md, "Sessions".
 */
export const sessionsModule: ServerModule = {
  name: 'sessions',
  routes: sessionRoutes,
  realtime: registerSessionSockets,
  stop: stopSessions,
}
