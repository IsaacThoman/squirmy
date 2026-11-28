import { enqueue, retireQueue, schedule } from '../../jobs/index.js'
import type { ServerModule } from '../types.js'
import { evictTranscodes } from './cache.js'
import { streamingRoutes } from './routes.js'
import { stopTranscodes } from './transcode.js'

export { buildPlaybackDescriptor } from './playback.js'
export { mimeFor, profiles, type MediaFile } from './profiles.js'
export { selectFile } from './select.js'
export { openStream } from './stream.js'
// For share links, which serve their own previews and streams through these.
export { serveFile, streamSignal, withLibraryFile, type StreamRequest, type StreamResponse } from './files.js'

export const streamingModule: ServerModule = {
  name: 'streaming',
  routes: streamingRoutes,
  async jobs(jobs) {
    jobs.define('streaming.evict', {}, evictTranscodes)
    await schedule('streaming.evict', '17 * * * *')
  },
  async start({ role }) {
    if (role !== 'api') {
      await enqueue('streaming.evict', {}, { singletonKey: 'evict' })
      // streaming.transcode was removed; nothing ever queued it.
      await retireQueue('streaming.transcode')
    }
  },
  stop: stopTranscodes,
}
