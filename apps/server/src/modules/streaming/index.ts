import { StreamProfile } from '@squirmy/contracts'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '../../database/client.js'
import { mediaFiles } from '../../database/schema.js'
import { enqueue, schedule } from '../../jobs/index.js'
import type { ServerModule } from '../types.js'
import { evictTranscodes } from './cache.js'
import { streamingRoutes } from './routes.js'
import { prepareTranscode, stopTranscodes } from './transcode.js'

export { buildPlaybackDescriptor } from './playback.js'
export { mimeFor } from './profiles.js'
export { selectFile } from './select.js'
export { openStream } from './stream.js'

const TranscodeJob = z.object({ fileId: z.string(), profile: StreamProfile.exclude(['original']) })

export const streamingModule: ServerModule = {
  name: 'streaming',
  routes: streamingRoutes,
  async jobs(jobs) {
    jobs.define('streaming.transcode', { concurrency: 2 }, async (data) => {
      const { fileId, profile } = TranscodeJob.parse(data)
      const [file] = await db.select().from(mediaFiles).where(eq(mediaFiles.id, fileId))
      if (file && !file.missingSince) await prepareTranscode(file, profile)
    })
    jobs.define('streaming.evict', {}, evictTranscodes)
    await schedule('streaming.evict', '17 * * * *')
  },
  async start({ role }) {
    if (role !== 'api') await enqueue('streaming.evict', {}, { singletonKey: 'evict' })
  },
  stop: stopTranscodes,
}
