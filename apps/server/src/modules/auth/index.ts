import type { ServerModule } from '../types.js'
import { authRoutes } from './routes.js'

export const authModule: ServerModule = {
  name: 'auth',
  routes: authRoutes,
}
