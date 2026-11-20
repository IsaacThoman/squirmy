import type { FastifyInstance } from 'fastify'
import type { JobRegistry } from '../jobs/types.js'
import type { Realtime } from '../realtime/types.js'

export type ServerRole = 'all' | 'api' | 'worker'

/** One feature area of the server. See docs/architecture.md for who owns what. */
export type ServerModule = {
  name: string
  /** HTTP routes. Called with an instance already prefixed with /api/v1. */
  routes?: (app: FastifyInstance) => void | Promise<void>
  /** Routes that need their own prefix (Subsonic's /rest). Called with the root instance. */
  rootRoutes?: (app: FastifyInstance) => void | Promise<void>
  /** Job handlers. Called in processes whose role includes the worker. */
  jobs?: (jobs: JobRegistry) => void | Promise<void>
  /** Socket handlers. Called in processes whose role includes the API. */
  realtime?: (realtime: Realtime) => void | Promise<void>
  /** Long-running loops (file watchers, schedulers). `stop` must undo `start`. */
  start?: (context: { role: ServerRole }) => void | Promise<void>
  stop?: () => void | Promise<void>
}
