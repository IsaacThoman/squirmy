import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { db } from '../database/client.js'
import { serverSettings } from '../database/schema.js'
import { useTestDatabase } from '../test/database.js'
import { drainJobs, enqueue, enqueueMany, getQueueStats, jobs, schedule, startJobs, stopJobs } from './index.js'

describe('jobs', () => {
  useTestDatabase()

  const seen: { data: { value: string }; attempt: number }[] = []
  const failures = new Map<string, number>()
  let release: (() => void) | undefined
  const finishSlowJob = async () => {
    await expect.poll(() => release, { timeout: 5000 }).toBeDefined()
    release!()
    release = undefined
    await drainJobs()
  }

  beforeAll(async () => {
    jobs.define<{ value: string }>('test.record', { concurrency: 2 }, async (data, context) => {
      seen.push({ data, attempt: context.attempt })
    })
    jobs.define<{ value: string; failTimes: number }>('test.flaky', { retryLimit: 2 }, async (data, context) => {
      failures.set(data.value, context.attempt)
      if (context.attempt <= data.failTimes) throw new Error(`attempt ${context.attempt} fails`)
    })
    jobs.define<{ value: string }>('test.slow', {}, async () => {
      await new Promise<void>((resolve) => { release = resolve })
    })
    jobs.define<{ value: string }>('test.stately', { policy: 'stately' }, async (data) => {
      seen.push({ data, attempt: 1 })
      if (data.value === 'first') await new Promise<void>((resolve) => { release = resolve })
    })
    await schedule('test.record', '0 4 * * *')
    await startJobs({ work: true })
  })
  afterAll(stopJobs)

  it('runs enqueued jobs and drains', async () => {
    await enqueue('test.record', { value: 'a' })
    await enqueue('test.record', { value: 'b' })
    await drainJobs()
    expect(seen.map((job) => job.data.value).sort()).toEqual(['a', 'b'])
    expect(seen.every((job) => job.attempt === 1)).toBe(true)
  })

  it('drops a duplicate singleton key while the first job is queued or active', async () => {
    const first = enqueue('test.slow', { value: 'one' }, { singletonKey: 'k' })
    expect(await first).not.toBeNull()
    expect(await enqueue('test.slow', { value: 'two' }, { singletonKey: 'k' })).toBeNull()
    await expect.poll(() => release, { timeout: 5000 }).toBeDefined()
    expect(await enqueue('test.slow', { value: 'three' }, { singletonKey: 'k' })).toBeNull()
    await finishSlowJob()
    expect(await enqueue('test.slow', { value: 'four' }, { singletonKey: 'k' })).not.toBeNull()
    await finishSlowJob()
  })

  it('retries a failing job and fails it after the retry limit', async () => {
    await enqueue('test.flaky', { value: 'recovers', failTimes: 1 })
    await enqueue('test.flaky', { value: 'gives-up', failTimes: 10 })
    await drainJobs()
    expect(failures.get('recovers')).toBe(2)
    expect(failures.get('gives-up')).toBe(3)
    const stats = await getQueueStats()
    expect(stats.find((queue) => queue.name === 'test.flaky')).toEqual({ name: 'test.flaky', queued: 0, active: 0, failed: 1 })
  })

  it('commits a job with the caller transaction and discards it on rollback', async () => {
    await expect(db.transaction(async (tx) => {
      await tx.insert(serverSettings).values({ key: 'rolled-back', value: 1 })
      await enqueue('test.record', { value: 'rolled-back' }, { tx })
      throw new Error('rollback')
    })).rejects.toThrow('rollback')

    await db.transaction(async (tx) => {
      await tx.insert(serverSettings).values({ key: 'committed', value: 1 })
      await enqueue('test.record', { value: 'committed' }, { tx })
    })
    await drainJobs()
    const values = seen.map((job) => job.data.value)
    expect(values).toContain('committed')
    expect(values).not.toContain('rolled-back')
  })

  it('leaves deferred jobs queued and honors priority', async () => {
    await enqueue('test.record', { value: 'later' }, { startAfter: 3600, priority: -5 })
    await drainJobs()
    expect(seen.map((job) => job.data.value)).not.toContain('later')
    const [row] = await db.execute<{ priority: number }>(sql`select priority from pgboss.job where data->>'value' = 'later'`)
    expect(row?.priority).toBe(-5)
    expect((await getQueueStats()).find((queue) => queue.name === 'test.record')?.queued).toBe(1)
  })

  it('registers schedules', async () => {
    const [row] = await db.execute<{ cron: string }>(sql`select cron from pgboss.schedule where name = 'test.record'`)
    expect(row?.cron).toBe('0 4 * * *')
  })

  it('skips keys already queued when enqueueing many', async () => {
    await enqueueMany('test.slow', [{ data: { value: 'a' }, singletonKey: 'same' }, { data: { value: 'b' }, singletonKey: 'same' }, { data: { value: 'c' }, singletonKey: 'other' }])
    const [row] = await db.execute<{ count: number }>(sql`select count(*)::int as count from pgboss.job where name = 'test.slow' and state in ('created', 'active')`)
    expect(row?.count).toBe(2)
    for (let job = 0; job < 2; job += 1) {
      await expect.poll(() => release, { timeout: 5000 }).toBeDefined()
      release!()
      release = undefined
    }
    await drainJobs()
  })

  it('keeps one follow-up of a stately job requested while it runs', async () => {
    await enqueue('test.stately', { value: 'first' }, { singletonKey: 'group' })
    await expect.poll(() => release, { timeout: 5000 }).toBeDefined()
    expect(await enqueue('test.stately', { value: 'follow-up' }, { singletonKey: 'group' })).not.toBeNull()
    expect(await enqueue('test.stately', { value: 'dropped' }, { singletonKey: 'group' })).toBeNull()
    release!()
    release = undefined
    await drainJobs()
    const values = seen.map((job) => job.data.value)
    expect(values).toContain('follow-up')
    expect(values).not.toContain('dropped')
  })
})
