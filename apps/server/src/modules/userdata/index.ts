import type { ServerModule } from '../types.js'
import { userdataRoutes } from './routes.js'

export const userdataModule: ServerModule = {
  name: 'userdata',
  routes: userdataRoutes,
}
