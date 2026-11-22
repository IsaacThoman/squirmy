import type { ServerModule } from '../types.js'

/**
 * Clients for external metadata services. Each checks its switch or key in the server
 * settings and returns null or an empty list when it is off, and never throws for "not
 * found". Other modules import them from here, e.g. `musicbrainz.getRelease(mbid)`.
 */
export * as acoustid from './acoustid.js'
export * as coverart from './coverart.js'
export * as deezer from './deezer.js'
export * as fanart from './fanart.js'
export { fetchImage, imageSourceEnabled, type FetchedImage } from './images.js'
export * as lastfm from './lastfm.js'
export * as listenbrainz from './listenbrainz.js'
export * as lrclib from './lrclib.js'
export * as musicbrainz from './musicbrainz.js'
export * as wikidata from './wikidata.js'

/** The metadata module has no routes or jobs; it only provides the clients above. */
export const metadataModule: ServerModule = {
  name: 'metadata',
}
