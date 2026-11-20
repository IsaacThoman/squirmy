/**
 * Bounds the enrichment that page routes wait for. One run per key is in flight at a
 * time and every caller joins it; a page waits at most the budget and then renders what
 * is known while the run carries on.
 */
import { getConfig } from '../../config.js'

const running = new Map<string, Promise<void>>()
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

/** Runs `work`, or joins the run already in flight for `key`. Rejects when the run does. */
export function shared(key: string, work: () => Promise<void>): Promise<void> {
  let run = running.get(key)
  if (!run) {
    run = work().finally(() => running.delete(key))
    running.set(key, run)
  }
  return run
}

/**
 * Waits for `run` for at most the budget. Resolves true when it settled in time and false
 * when it is still going. Never rejects: a failed run is logged and counts as settled.
 */
export async function withinBudget(run: Promise<void>, label: string): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), budgetMs)
  })
  const settled = run.then(() => true, (error: unknown) => {
    warn(`${label} failed`, error)
    return true
  })
  try {
    return await Promise.race([settled, timeout])
  } finally {
    clearTimeout(timer)
  }
}
