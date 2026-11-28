import { schedule } from '../../jobs/index.js'
import { HISTORY_IMPORT_QUEUE, HISTORY_IMPORT_RETRIES, processHistoryImport, sweepHistoryImports } from './history-import.js'
import type { ServerModule } from '../types.js'
import { fetchSaved, type FetchSavedJob } from './library.js'
import { userdataRoutes } from './routes.js'

/**
 * Likes, ratings, playlists, history, wants, library saves and user settings. Jobs:
 *   userdata.fetch-saved  { userId, type, id }  fetches what a library save is missing
 */
export const userdataModule: ServerModule = {
  name: 'userdata',
  routes: userdataRoutes,
  async jobs(jobs) {
    jobs.define(HISTORY_IMPORT_QUEUE, { concurrency: 1, retryLimit: HISTORY_IMPORT_RETRIES }, processHistoryImport)
    jobs.define('userdata.history-import-sweep', {}, async () => sweepHistoryImports())
    await schedule('userdata.history-import-sweep', '43 * * * *')
    // Waits on the album's track list from the metadata sources before asking for files.
    jobs.define<FetchSavedJob>('userdata.fetch-saved', { concurrency: 2, timeoutSeconds: 300 }, fetchSaved)
  },
}
