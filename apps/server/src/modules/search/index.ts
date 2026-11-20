import type { ServerModule } from '../types.js'
import { searchRoutes } from './routes.js'

/** Library search, catalog search through the providers in providers.ts, and the stub rows catalog results are stored as. */
export const searchModule: ServerModule = {
  name: 'search',
  routes: searchRoutes,
}
