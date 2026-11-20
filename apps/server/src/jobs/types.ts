import type { Executor } from '../database/client.js'

export type JobDefinition = {
  /** How many of this job one worker process runs at once. Default 1. */
  concurrency?: number
  /** Retries after a thrown error, with backoff. Default 3. */
  retryLimit?: number
  /** A job running longer than this is failed and retried. Default 15 minutes. */
  timeoutSeconds?: number
}

export type EnqueueOptions = {
  /** At most one queued or active job per key; a duplicate enqueue is a no-op. */
  singletonKey?: string
  /** Higher runs first. Use negative values for heavy background work. */
  priority?: number
  /** Delay in seconds, or the time to run at. */
  startAfter?: number | Date
  /** Insert the job in this transaction so it commits with the rows it refers to. */
  tx?: Executor
}

export type JobContext = { id: string; attempt: number }

export type JobHandler<T> = (data: T, context: JobContext) => Promise<void>

/** What a module receives in its `jobs` hook. */
export interface JobRegistry {
  define<T extends object>(name: string, options: JobDefinition, handler: JobHandler<T>): void
}
