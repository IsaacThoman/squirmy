import { lt } from 'drizzle-orm'
import { db } from '../../database/client.js'
import { shares } from '../../database/schema.js'
import { schedule } from '../../jobs/index.js'
import type { ServerModule } from '../types.js'
import { EXPIRED_KEPT_MS } from './links.js'
import { sweepPreviews } from './preview.js'
import { shareRoutes } from './routes.js'

/**
 * The `share.sweep` job: deletes links that expired a while ago (their creators saw them listed
 * as expired until then) and previews nobody has played lately.
 */
export async function sweepShares(now = Date.now()) {
  await db.delete(shares).where(lt(shares.expiresAt, new Date(now - EXPIRED_KEPT_MS)))
  await sweepPreviews(now)
}

export const shareModule: ServerModule = {
  name: 'share',
  routes: shareRoutes,
  async jobs(jobs) {
    jobs.define('share.sweep', {}, () => sweepShares())
    await schedule('share.sweep', '35 4 * * *')
  },
}
