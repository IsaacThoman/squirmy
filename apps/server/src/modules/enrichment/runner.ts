/**
 * Bounds the enrichment that page routes wait for. One run per key is in flight at a
 * time and every caller joins it; a page waits at most the budget and then renders what
 * is known while the run carries on.
 */
import { getConfig } from '../../config.js'

type Run = {
  done: Promise<void>
  startedAt: number
  /** Resolves when the work says a page can render what it has written so far. */
  usable: Promise<void>
}

const running = new Map<string, Run>()
let budgetMs = 4000

/** How long a page waits for enrichment before rendering what is known. Tests shorten it. */
export function setDetailBudget(ms: number) {
  budgetMs = ms
}

export function warn(message: string, error?: unknown) {
  if (getConfig().LOG_LEVEL === 'silent') return
  if (error === undefined) console.warn(`[enrichment] ${message}`)
  else console.warn(`[enrichment] ${message}`, error)
}

/**
 * Runs `work`, or joins the run already in flight for `key`. Rejects when the run does.
 * `work` may call `usable` once what it wrote is worth showing before it finishes (a
 * provider's track list while MusicBrainz is still answering).
 */
export function shared(key: string, work: (usable: () => void) => Promise<void>): Promise<void> {
  return start(key, work).done
}

function start(key: string, work: (usable: () => void) => Promise<void>): Run {
  let run = running.get(key)
  if (!run) {
    let usable: () => void = () => {}
    const signal = new Promise<void>((resolve) => {
      usable = resolve
    })
    const done = work(usable).finally(() => running.delete(key))
    run = { done, startedAt: Date.now(), usable: signal }
    running.set(key, run)
  }
  return run
}

/**
 * How a page's wait ended: `done` when the run settled (a failed run counts, and is
 * logged), `usable` when the run said its partial result can be shown, `pending` when
 * the budget ran out.
 */
export type Outcome = 'done' | 'usable' | 'pending'

/**
 * Joins the run for `key` (starting it when none is in flight) and waits for it, at most
 * for what is left of the budget since the run started: a page opened again while an
 * earlier visit's run is still going answers at once. Never rejects.
 */
export async function onBudget(key: string, work: (usable: () => void) => Promise<void>, label: string): Promise<Outcome> {
  const run = start(key, work)
  const remaining = Math.max(0, budgetMs - (Date.now() - run.startedAt))
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<Outcome>((resolve) => {
    timer = setTimeout(() => resolve('pending'), remaining)
  })
  const settled = run.done.then((): Outcome => 'done', (error: unknown): Outcome => {
    warn(`${label} failed`, error)
    return 'done'
  })
  const usable = run.usable.then((): Outcome => 'usable')
  try {
    return await Promise.race([settled, usable, timeout])
  } finally {
    clearTimeout(timer)
  }
}
