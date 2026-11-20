import type { JobQueueStats } from '@squirmy/contracts'
import { sql } from 'drizzle-orm'
import { fromDrizzle, PgBoss, type QueueOptions } from 'pg-boss'
import { getConfig } from '../config.js'
import { db } from '../database/client.js'
import { newId } from '../lib/ids.js'
import type { EnqueueOptions, JobDefinition, JobHandler, JobRegistry } from './types.js'

export type { EnqueueOptions, JobContext, JobDefinition, JobHandler, JobRegistry } from './types.js'

/**
 * Every queue uses pg-boss's `exclusive` policy: at most one created, retry or active job
 * per singleton key. Jobs enqueued without a key get a unique one, so only keyed jobs
 * are deduplicated.
 */
const baseQueue = { policy: 'exclusive', retryLimit: 3, retryBackoff: true, retryDelay: 5, notify: true } as const

type Definition = { options: JobDefinition; handler: JobHandler<object> }

const definitions = new Map<string, Definition>()
const schedules = new Map<string, string>()
const queues = new Set<string>()
let boss: PgBoss | undefined
let workerIds: string[] = []

/** Collects job handlers. Modules receive it in their `jobs` hook, before `startJobs`. */
export const jobs: JobRegistry = {
  define(name, options, handler) {
    if (boss) throw new Error(`Define ${name} before the job system starts`)
    if (definitions.has(name)) throw new Error(`Job ${name} is already defined`)
    definitions.set(name, { options, handler: handler as JobHandler<object> })
  },
}

function running(): PgBoss {
  if (!boss) throw new Error('The job system is not started')
  return boss
}

/** Creates the queue on first use, so a process that only enqueues does not need the definition. */
async function ensureQueue(name: string, options: QueueOptions = {}) {
  if (queues.has(name)) return
  await running().createQueue(name, { ...baseQueue, ...options })
  queues.add(name)
}

/** Adds a job. Returns its id, or null when a job with the same singleton key is already queued or active. */
export async function enqueue<T extends object>(name: string, data: T, options: EnqueueOptions = {}): Promise<string | null> {
  await ensureQueue(name)
  // pg-boss validates keys that are present, even when undefined.
  return running().send(name, data, {
    singletonKey: options.singletonKey ?? newId(),
    ...(options.priority !== undefined && { priority: options.priority }),
    ...(options.startAfter !== undefined && { startAfter: options.startAfter }),
    ...(options.tx && { db: fromDrizzle(options.tx, sql) }),
  })
}

/**
 * Adds many jobs in one statement. Jobs whose singleton key is already queued or active are
 * skipped, as with `enqueue`.
 */
export async function enqueueMany<T extends object>(name: string, items: readonly { data: T; singletonKey?: string; priority?: number }[]) {
  if (items.length === 0) return
  await ensureQueue(name)
  await running().insert(name, items.map((item) => ({
    data: item.data,
    singletonKey: item.singletonKey ?? newId(),
    ...(item.priority !== undefined && { priority: item.priority }),
  })))
}

/** Runs `name` on a cron expression (UTC). Call it from a module's `jobs` hook or after `startJobs`. */
export async function schedule(name: string, cron: string) {
  schedules.set(name, cron)
  if (!boss) return
  await ensureQueue(name)
  await boss.schedule(name, cron)
}

/** Live counts for every queue, read from pg-boss's job table rather than its periodic cache. */
export async function getQueueStats(): Promise<JobQueueStats[]> {
  const rows = await db.execute<JobQueueStats>(sql`
    select q.name,
      count(j.id) filter (where j.state in ('created', 'retry'))::int as queued,
      count(j.id) filter (where j.state = 'active')::int as active,
      count(j.id) filter (where j.state = 'failed')::int as failed
    from pgboss.queue q
    left join pgboss.job j on j.name = q.name
    group by q.name
    order by q.name`)
  return [...rows]
}

/**
 * Starts pg-boss. Every role needs it to enqueue; `work` also runs the defined handlers and
 * the cron schedules.
 */
export async function startJobs({ work }: { work: boolean }) {
  if (boss) throw new Error('The job system is already started')
  const config = getConfig()
  const instance = new PgBoss({
    connectionString: config.DATABASE_URL,
    application_name: 'squirmy-jobs',
    max: config.NODE_ENV === 'test' ? 3 : 6,
    useListenNotify: work,
    schedule: work,
  })
  instance.on('error', (error) => {
    if (config.LOG_LEVEL !== 'silent') console.error('[jobs]', error)
  })
  await instance.start()
  boss = instance

  for (const [name, { options }] of definitions) {
    const queue = { retryLimit: options.retryLimit ?? baseQueue.retryLimit, expireInSeconds: options.timeoutSeconds ?? 15 * 60 }
    await ensureQueue(name, { ...queue, ...(options.policy && { policy: options.policy }) })
    // createQueue keeps an existing queue's options; apply the definition's. The policy is
    // fixed when the queue is created.
    await instance.updateQueue(name, queue)
  }
  if (!work) return

  for (const [name, { options, handler }] of definitions) {
    // One pg-boss worker per slot, so each can be woken by id. With LISTEN/NOTIFY on, a
    // worker otherwise waits out the 30 second notify backstop after every job, and a
    // backlog drains at one job per slot per 30 seconds.
    for (let slot = 0; slot < (options.concurrency ?? 1); slot += 1) {
      let id = ''
      id = await instance.work<object>(name, { localConcurrency: 1 }, async ([job]) => {
        if (!job) return
        try {
          await handler(job.data, { id: job.id, attempt: job.retryCount + 1 })
        } finally {
          instance.notifyWorker(id)
        }
      })
      workerIds.push(id)
    }
  }
  for (const [name, cron] of schedules) {
    await ensureQueue(name)
    await instance.schedule(name, cron)
  }
  for (const stale of await instance.getSchedules()) {
    if (!schedules.has(stale.name)) await instance.unschedule(stale.name, stale.key)
  }
}

/** Stops workers (letting active jobs finish) and forgets every definition and schedule. */
export async function stopJobs() {
  const instance = boss
  boss = undefined
  workerIds = []
  queues.clear()
  definitions.clear()
  schedules.clear()
  await instance?.stop({ graceful: true, timeout: 20_000 })
}

/**
 * For tests: resolves once no job is ready or active. Jobs waiting out a retry backoff are
 * pulled forward so failures settle quickly; jobs deferred with `startAfter` are left alone.
 */
export async function drainJobs({ timeoutMs = 20_000 } = {}) {
  const instance = running()
  // Jobs of queues this process has no handler for would never settle.
  const names = [...definitions.keys()]
  if (names.length === 0) return
  const deadline = Date.now() + timeoutMs
  for (;;) {
    await db.execute(sql`update pgboss.job set start_after = now() where name in ${names} and state = 'retry' and start_after > now()`)
    // Every retry counts as pending, whatever its start_after: a job can fail between the
    // update above and this count, and its retry is not done just because it waits.
    const [row] = await db.execute<{ pending: number }>(sql`
      select count(*)::int as pending from pgboss.job
      where name in ${names} and (state in ('active', 'retry') or (state = 'created' and start_after <= now()))`)
    if (!row?.pending) return
    if (Date.now() > deadline) throw new Error(`${row.pending} jobs still pending after ${timeoutMs} ms`)
    for (const id of workerIds) instance.notifyWorker(id)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}
