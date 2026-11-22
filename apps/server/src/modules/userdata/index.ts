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
  jobs(jobs) {
    // Waits on the album's track list from the metadata sources before asking for files.
    jobs.define<FetchSavedJob>('userdata.fetch-saved', { concurrency: 2, timeoutSeconds: 300 }, fetchSaved)
  },
}
