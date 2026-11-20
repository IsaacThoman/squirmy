import type { ServerModule } from '../types.js'
import { radioRoutes } from './routes.js'

export { similarArtists, type SimilarArtist } from './similar.js'

/**
 * Autoplay suggestions (the `suggestAutoplay` seam in `suggest.ts`) and radios started
 * from a track or an artist. See `ranking.ts` for how tracks are chosen.
 */
export const radioModule: ServerModule = {
  name: 'radio',
  routes: radioRoutes,
}
