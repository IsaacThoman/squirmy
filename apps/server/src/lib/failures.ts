/**
 * Counts failures per key in a fixed window, in this process only. Unlike the rate limit
 * plugin, nothing is counted until the caller says an attempt failed, so a correct sign-in
 * never uses up anyone's budget.
 */
export class FailureCounter {
  private readonly entries = new Map<string, { count: number; resetAt: number }>()

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    /** Bounds memory when a flood brings new keys faster than windows end. */
    private readonly maxKeys = 10_000,
  ) {}

  /** Seconds until `key` may try again, or 0 when it is under the limit. */
  blockedFor(key: string, now = Date.now()): number {
    const entry = this.entries.get(key)
    if (!entry || entry.resetAt <= now || entry.count < this.limit) return 0
    return Math.max(1, Math.ceil((entry.resetAt - now) / 1000))
  }

  fail(key: string, now = Date.now()) {
    const entry = this.entries.get(key)
    if (entry && entry.resetAt > now) {
      entry.count += 1
      return
    }
    this.entries.delete(key)
    if (this.entries.size >= this.maxKeys) this.prune(now)
    this.entries.set(key, { count: 1, resetAt: now + this.windowMs })
  }

  clear(key: string) {
    this.entries.delete(key)
  }

  reset() {
    this.entries.clear()
  }

  private prune(now: number) {
    for (const [key, entry] of this.entries) if (entry.resetAt <= now) this.entries.delete(key)
    // Still full: drop the oldest windows. Insertion order is window start order.
    for (const key of this.entries.keys()) {
      if (this.entries.size < this.maxKeys) break
      this.entries.delete(key)
    }
  }
}
