import type { ServerModule } from '../types.js'
import { adminRoutes } from './routes.js'

export const adminModule: ServerModule = {
  name: 'admin',
  routes: adminRoutes,
}
