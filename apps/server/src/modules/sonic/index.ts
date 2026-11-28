import type { ServerSettings } from '@squirmy/contracts'
import { enqueue, schedule } from '../../jobs/index.js'
import type { ServerModule } from '../types.js'
import { analyzeFile, fetchDeezerTempo, type AnalyzeJob, type DeezerTempoJob } from './analyze.js'
import { sonicRoutes } from './routes.js'
import { sweepSonic } from './sweep.js'

export { analyzeSoon } from './sweep.js'

export { fileTimings, sonicNeighbours, sonicPoints, sonicProgress, type SonicPoint } from './profile.js'
export { camelot, keyDistance, keyName, parseKey, type MusicalKey } from './keys.js'
export { centroid, distance, neighbourhood, sonicIndex, vectorOf, type Neighbourhood, type SonicIndex } from './vectors.js'

/** Starts a sweep at once when analysis is switched on, rather than within ten minutes. */
export async function queueSonicSweep(before: ServerSettings, after: ServerSettings) {
  if (!before.sonicAnalysisEnabled && after.sonicAnalysisEnabled) await enqueue('sonic.sweep', {}, { singletonKey: 'sweep' })
}

/**
 * Sonic analysis: tempo, key, energy and timbre of every file, measured by Squirmy's own
 * DSP (`dsp/`) from audio ffmpeg decodes, plus tempo, key and mood tags and Deezer's
 * tempo. Radio ranks with it (`profile.ts`, `vectors.ts`).
 */
export const sonicModule: ServerModule = {
  name: 'sonic',
  routes: sonicRoutes,
  async jobs(jobs) {
    // One slot: analysis takes one core at most, however long the backlog.
    jobs.define<AnalyzeJob>('sonic.analyze', { concurrency: 1, retryLimit: 1, timeoutSeconds: 30 * 60 }, analyzeFile)
    jobs.define<DeezerTempoJob>('sonic.deezer-tempo', { concurrency: 1 }, fetchDeezerTempo)
    jobs.define('sonic.sweep', {}, sweepSonic)
    await schedule('sonic.sweep', '*/10 * * * *')
  },
  async start({ role }) {
    if (role !== 'api') await enqueue('sonic.sweep', {}, { singletonKey: 'sweep' })
  },
}
