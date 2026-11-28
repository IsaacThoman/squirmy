import type { ServerModule } from '../types.js'
import { radioRoutes } from './routes.js'

export { becauseYouListened, type BecauseYouListened } from './because.js'
export { listMixes, makeMixes, mixSummaries, saveMixes } from './mixes.js'
export { canStartArtistRadio } from './radio.js'
export { isRequester } from './ranking.js'
export { similarArtists, type SimilarArtist } from './similar.js'

/**
 * Autoplay suggestions (the `suggestAutoplay` seam in `suggest.ts`), radios started from a
 * track or an artist, and the mixes made for each user (`mixes.ts`, made daily by catalog's
 * `catalog.home-picks` job). See `ranking.ts` for how tracks are chosen.
 */
export const radioModule: ServerModule = {
  name: 'radio',
  routes: radioRoutes,
}
