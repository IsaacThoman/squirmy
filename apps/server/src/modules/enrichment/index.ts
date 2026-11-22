import { enqueue, schedule } from '../../jobs/index.js'
import type { ServerModule } from '../types.js'
import { fallbackCover } from './covers.js'
import { artistDetailRun, lyricsRun } from './detail.js'
import { enrichAlbum } from './owned.js'
import { foldArtistCopy } from './artist-copies.js'
import { repairReleases } from './repair.js'
import { reconcileArtistAlbums } from './reconcile.js'
import { refreshNewReleases } from './releases.js'
import { sweep } from './sweep.js'

/** Payloads of the enrichment jobs. The matching module queues the first two after a match. */
export type EnrichAlbumJob = { albumId: string }
export type EnrichArtistJob = { artistId: string }
export type EnrichLyricsJob = { recordingId: string }
/** Queued by the artwork module when it unassigns a cover its source does not have. */
export type EnrichCoverJob = { albumId: string }
/** Queued by search when it writes album stubs for an artist (reconcile.ts). Without an artist: the whole repair. */
export type ReconcileJob = {
  artistId?: string
  /** A Deezer-only artist row search stored beside another of its name: merged when it is a second page (artist-copies.ts). */
  artistCopy?: string
}

/**
 * Completes catalog rows on demand (the `detail.ts` seam) and decorates owned music in
 * the background:
 *   enrichment.album         { albumId }      detail, then cover, description, Deezer ids, lyrics for owned albums
 *   enrichment.artist        { artistId }     profile, discography, image, bio, top tracks
 *   enrichment.lyrics        { recordingId }  an LRCLIB lookup
 *   enrichment.cover         { albumId }      another cover when its source has none (covers.ts)
 *   enrichment.sweep         queues owned music that was never enriched, every 30 minutes
 *   enrichment.new-releases  refreshes library artists' discographies, weekly
 *   enrichment.reconcile     { artistId? }    merges an artist's duplicate album rows; { artistCopy }
 *                                             merges a second Deezer page into its artist; with neither,
 *                                             the release repair (repair.ts): daily and at worker start
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
    registry.define<EnrichCoverJob>('enrichment.cover', { concurrency: 2, retryLimit: 1 }, async ({ albumId }) => {
      await fallbackCover(albumId)
    })
    registry.define('enrichment.sweep', { retryLimit: 1 }, async () => {
      await sweep()
    })
    registry.define('enrichment.new-releases', { retryLimit: 1, timeoutSeconds: 6 * 60 * 60 }, async () => {
      await refreshNewReleases()
    })
    registry.define<ReconcileJob>('enrichment.reconcile', { retryLimit: 1, timeoutSeconds: 60 * 60 }, async ({ artistId, artistCopy }) => {
      if (artistCopy) await foldArtistCopy(artistCopy)
      else if (artistId) await reconcileArtistAlbums(artistId)
      else await repairReleases()
    })
    await schedule('enrichment.sweep', '*/30 * * * *')
    await schedule('enrichment.reconcile', '50 4 * * *')
    await schedule('enrichment.new-releases', '0 6 * * 1')
  },
  async start({ role }) {
    if (role !== 'api') {
      await enqueue('enrichment.sweep', {}, { singletonKey: 'sweep' })
      await enqueue('enrichment.reconcile', {}, { singletonKey: 'repair' })
    }
  },
}
