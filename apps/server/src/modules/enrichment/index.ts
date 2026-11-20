import { enqueue, schedule } from '../../jobs/index.js'
import type { ServerModule } from '../types.js'
import { artistDetailRun, lyricsRun } from './detail.js'
import { enrichAlbum } from './owned.js'
import { refreshNewReleases } from './releases.js'
import { sweep } from './sweep.js'

/** Payloads of the enrichment jobs. The matching module queues the first two after a match. */
export type EnrichAlbumJob = { albumId: string }
export type EnrichArtistJob = { artistId: string }
export type EnrichLyricsJob = { recordingId: string }

/**
 * Completes catalog rows on demand (the `detail.ts` seam) and decorates owned music in
 * the background:
 *   enrichment.album         { albumId }      detail, then cover, description, Deezer ids, lyrics for owned albums
 *   enrichment.artist        { artistId }     profile, discography, image, bio, top tracks
 *   enrichment.lyrics        { recordingId }  an LRCLIB lookup
 *   enrichment.sweep         queues owned music that was never enriched, every 30 minutes
 *   enrichment.new-releases  refreshes library artists' discographies, weekly
 */
export const enrichmentModule: ServerModule = {
  name: 'enrichment',
  async jobs(registry) {
    // One at a time: these mostly wait on MusicBrainz's one request a second, and every
    // request queued here is one a page opened meanwhile waits behind.
    registry.define<EnrichAlbumJob>('enrichment.album', { timeoutSeconds: 15 * 60 }, async ({ albumId }) => {
      await enrichAlbum(albumId)
    })
    registry.define<EnrichArtistJob>('enrichment.artist', { timeoutSeconds: 15 * 60 }, async ({ artistId }) => {
      await artistDetailRun(artistId)
    })
    registry.define<EnrichLyricsJob>('enrichment.lyrics', { concurrency: 2 }, async ({ recordingId }) => {
      await lyricsRun(recordingId)
    })
    registry.define('enrichment.sweep', { retryLimit: 1 }, async () => {
      await sweep()
    })
    registry.define('enrichment.new-releases', { retryLimit: 1, timeoutSeconds: 6 * 60 * 60 }, async () => {
      await refreshNewReleases()
    })
    await schedule('enrichment.sweep', '*/30 * * * *')
    await schedule('enrichment.new-releases', '0 6 * * 1')
  },
  async start({ role }) {
    if (role !== 'api') await enqueue('enrichment.sweep', {}, { singletonKey: 'sweep' })
  },
}
