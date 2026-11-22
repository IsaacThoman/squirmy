import { schedule } from '../../jobs/index.js'
import type { ServerModule } from '../types.js'
import { recoverAsset, sweepArtwork, type RecoverJob } from './recover.js'
import { artworkRoutes } from './renditions.js'

export { albumArtFromFiles, artistImageFromFolder, pickEmbeddedPicture, storeEmbeddedPicture, type EmbeddedPicture } from './files.js'
export { readOriginal } from './recover.js'
export { assignAlbumArtwork, ensureStored, remoteImage, retryFailedAfterMs, storeImage, type Asset, type AssetKind, type StoredAsset } from './store.js'

export const artworkModule: ServerModule = {
  name: 'artwork',
  routes: artworkRoutes,
  async jobs(jobs) {
    jobs.define<RecoverJob>('artwork.recover', { concurrency: 2, retryLimit: 1 }, recoverAsset)
    jobs.define('artwork.sweep', { retryLimit: 1 }, sweepArtwork)
    await schedule('artwork.sweep', '40 4 * * *')
  },
}
