import type { ServerModule } from '../types.js'
import { organizeJobs } from './jobs.js'
import { organizeRoutes } from './routes.js'

export const organizeModule: ServerModule = {
  name: 'organize',
  routes: organizeRoutes,
  jobs: organizeJobs,
}
