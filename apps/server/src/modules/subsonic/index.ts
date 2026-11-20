import type { ServerModule } from '../types.js'
import { subsonicRoutes } from './router.js'

/** OpenSubsonic under `/rest`: a second front door over the same services. See docs/subsonic.md. */
export const subsonicModule: ServerModule = {
  name: 'subsonic',
  rootRoutes: subsonicRoutes,
}
