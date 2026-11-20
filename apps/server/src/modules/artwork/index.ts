import type { ServerModule } from '../types.js'
import { artworkRoutes } from './renditions.js'

export { albumArtFromFiles, artistImageFromFolder, pickEmbeddedPicture, storeEmbeddedPicture, type EmbeddedPicture } from './files.js'
export { assignAlbumArtwork, storeImage, type Asset, type AssetKind } from './store.js'

export const artworkModule: ServerModule = {
  name: 'artwork',
  routes: artworkRoutes,
}
