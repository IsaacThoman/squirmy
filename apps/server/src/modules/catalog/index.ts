import type { ServerModule } from '../types.js'
import { catalogRoutes } from './routes.js'

export const catalogModule: ServerModule = {
  name: 'catalog',
  routes: catalogRoutes,
}
