import type { JobRegistry } from '../../jobs/index.js'
import { applyBatch } from './apply.js'
import { revertBatch } from './revert.js'
import { invalidateBatches } from './routes.js'

export type OrganizeJob = { batchId: string }

// Applying a large library across file systems copies every byte, so allow hours. If a
// job outlives this and is retried, the root lock keeps the two runs apart.
const timeoutSeconds = 6 * 60 * 60

/**
 * `organize.apply` and `organize.revert`, keyed by batch id. Both are resumable, so a
 * retry after a crash picks up where the last run stopped.
 */
export function organizeJobs(jobs: JobRegistry) {
  jobs.define<OrganizeJob>('organize.apply', { timeoutSeconds }, async ({ batchId }) => {
    try {
      await applyBatch(batchId)
    } finally {
      await invalidateBatches()
    }
  })
  jobs.define<OrganizeJob>('organize.revert', { timeoutSeconds }, async ({ batchId }) => {
    try {
      await revertBatch(batchId)
    } finally {
      await invalidateBatches()
    }
  })
}
