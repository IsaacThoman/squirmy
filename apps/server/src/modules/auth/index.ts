import type { ServerModule } from '../types.js'
import { registerLanDiscovery } from './discovery.js'
import { tvPairingRoutes } from './pairing.js'
import { authRoutes } from './routes.js'
import { ssoRoutes } from './sso-routes.js'

export const authModule: ServerModule = {
  name: 'auth',
  routes: async (app) => {
    await authRoutes(app)
    await ssoRoutes(app)
    await tvPairingRoutes(app)
    registerLanDiscovery(app)
  },
}
