/**
 * Getting job outcomes to the playback sessions. Sessions live in the API process, and jobs
 * finish in workers, so an outcome is a NOTIFY on its own channel that the API process
 * applies with `markRecordingReady` / `markRecordingFailed`.
 *
 * Sessions ask for an on-demand recording once per load and then wait for that answer. A
 * notification lost while the listening connection reconnects would leave an entry
 * `preparing` until the session reloads, so the API process also reconciles every half
 * minute: for recordings of jobs that finished recently, owned means ready, and not owned
 * with no job still working on it means failed. Marking an entry ready again changes
 * nothing, and failing a track never stops a current entry that is ready: it is playing.
 *
 * Ready may come before the job ends: `acquisition.finish` announces recordings as soon as
 * a delivered file is usable, while the import is still identifying.
 */
import { sql } from 'drizzle-orm'
import { getConfig } from '../../config.js'
import { db, getSql } from '../../database/client.js'
import { uuidArray } from '../catalog/sql.js'
import { ownedRecordings } from './catalog.js'
import { markRecordingFailed, markRecordingReady } from '../sessions/index.js'
import { OUTAGE_REASON } from './health.js'
import { activeProviders } from './providers.js'

/** `outage`: the recordings failed because their provider is failing (health.ts). */
export type Outcome = { ready: string[]; failed: string[]; outage?: boolean }

const channel = 'squirmy_acquisition'
const maxPayloadBytes = 7900
const timing = { reconcileMs: 30_000, windowMs: 10 * 60_000 }

let listener: { unlisten: () => Promise<void> } | null = null
let timer: ReturnType<typeof setInterval> | null = null

function report(error: unknown) {
  if (getConfig().LOG_LEVEL !== 'silent') console.error('[acquisition]', error)
}

/** Sends an outcome to the API process. Works from any process. */
export async function announceOutcome(outcome: Partial<Outcome>) {
  const ids = [...(outcome.ready ?? []).map((id) => ({ id, ready: true })), ...(outcome.failed ?? []).map((id) => ({ id, ready: false }))]
  // A uuid takes 39 bytes in the payload, so 150 per notification stays under the limit.
  for (let start = 0; start < ids.length; start += 150) {
    const slice = ids.slice(start, start + 150)
    const payload = JSON.stringify({
      ready: slice.filter((item) => item.ready).map((item) => item.id),
      failed: slice.filter((item) => !item.ready).map((item) => item.id),
      ...(outcome.outage ? { outage: true } : {}),
    })
    if (Buffer.byteLength(payload) > maxPayloadBytes) throw new Error('Acquisition outcome too large')
    await getSql()`select pg_notify(${channel}, ${payload})`
  }
}

/** Applies an outcome to the loaded sessions. Must run in the API process. */
export async function applyOutcome({ ready, failed, outage }: Outcome) {
  for (const id of ready) await markRecordingReady(id)
  for (const id of failed) await markRecordingFailed(id, outage ? OUTAGE_REASON : undefined)
}

/**
 * The outcome for recordings of jobs that finished in the last few minutes, as the database
 * tells it now.
 */
export async function recentOutcome(now = Date.now()): Promise<Outcome> {
  const rows = await db.execute<{ id: string; working: boolean }>(sql`
    with recent as (
      select distinct unnest(recording_ids) as id from acquisition_jobs
      where completed_at > ${new Date(now - timing.windowMs).toISOString()}
    )
    select recent.id, exists (select 1 from acquisition_jobs j where j.completed_at is null and j.recording_ids @> array[recent.id]) as working
    from recent`)
  const owned = await ownedRecordings(rows.map((row) => row.id))
  return {
    ready: rows.filter((row) => owned.has(row.id)).map((row) => row.id),
    failed: rows.filter((row) => !owned.has(row.id) && !row.working).map((row) => row.id),
  }
}

/** Starts listening for outcomes and reconciling. API roles call it from the module's `start`. */
export async function startOutcomes() {
  if (listener) return
  listener = await getSql().listen(channel, (payload) => {
    try {
      void applyOutcome(JSON.parse(payload) as Outcome).catch(report)
    } catch (error) {
      report(error)
    }
  })
  timer = setInterval(() => {
    void (async () => {
      if ((await activeProviders()).length === 0) return
      await applyOutcome(await recentOutcome())
    })().catch(report)
  }, timing.reconcileMs)
  timer.unref()
}

export async function stopOutcomes() {
  if (timer) clearInterval(timer)
  timer = null
  const current = listener
  listener = null
  await current?.unlisten()
}

/** Ids among `ids` that some unfinished job (other than `exceptJobId`) is still working on. */
export async function stillWorking(ids: readonly string[], exceptJobId?: string): Promise<Set<string>> {
  if (ids.length === 0) return new Set()
  const rows = await db.execute<{ id: string }>(sql`
    select distinct unnest(recording_ids) as id from acquisition_jobs
    where completed_at is null and recording_ids && ${uuidArray(ids)} ${exceptJobId ? sql`and id <> ${exceptJobId}` : sql``}`)
  return new Set(rows.map((row) => row.id).filter((id) => ids.includes(id)))
}
