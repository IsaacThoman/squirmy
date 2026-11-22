/**
 * Counts failures per key in a fixed window, in this process only. Unlike the rate limit
 * plugin, a caller that knows an attempt succeeded can take it back, so a correct sign-in
 * never uses up anyone's budget.
 */
export class FailureCounter {
  private readonly entries = new Map<string, { count: number; resetAt: number }>()

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    /** Bounds memory when a flood brings new keys faster than windows end. */
    private readonly maxKeys = 50_000,
  ) {}

  /** Seconds until `key` may try again, or 0 when it is under the limit. */
  blockedFor(key: string, now = Date.now()): number {
    const entry = this.entries.get(key)
    if (!entry || entry.resetAt <= now || entry.count < this.limit) return 0
    return Math.max(1, Math.ceil((entry.resetAt - now) / 1000))
  }

  /**
   * Counts one failure. Count before the slow check and `undo` on success: checking
   * `blockedFor` and counting in the same tick is what stops concurrent attempts from
   * all passing the check while the first is still being verified.
   */
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

  /** Takes back one failure counted by `fail`, for an attempt that turned out to succeed. */
  undo(key: string, now = Date.now()) {
    const entry = this.entries.get(key)
    if (entry && entry.resetAt > now && entry.count > 0) entry.count -= 1
  }

  clear(key: string) {
    this.entries.delete(key)
  }

  reset() {
    this.entries.clear()
  }

  /**
   * Makes room for a new key. Ended windows go first, then keys under the limit, oldest
   * first; a key that is blocked goes only when nothing else is left, so a flood of new
   * keys cannot wash out the count of the key it is attacking.
   */
  private prune(now: number) {
    for (const [key, entry] of this.entries) if (entry.resetAt <= now) this.entries.delete(key)
    for (const [key, entry] of this.entries) {
      if (this.entries.size < this.maxKeys) return
      if (entry.count < this.limit) this.entries.delete(key)
    }
    for (const key of this.entries.keys()) {
      if (this.entries.size < this.maxKeys) return
      this.entries.delete(key)
    }
  }
}

/** Keys seen succeeding lately, such as the addresses an account signed in from. */
export class KnownPlaces {
  private readonly entries = new Map<string, number>()

  constructor(private readonly ttlMs: number, private readonly maxKeys = 50_000) {}

  has(key: string, now = Date.now()): boolean {
    const expiresAt = this.entries.get(key)
    return expiresAt !== undefined && expiresAt > now
  }

  add(key: string, now = Date.now()) {
    this.entries.delete(key)
    // Oldest first, since Map keeps insertion order and re-adding moves a key to the end.
    for (const oldest of this.entries.keys()) {
      if (this.entries.size < this.maxKeys) break
      this.entries.delete(oldest)
    }
    this.entries.set(key, now + this.ttlMs)
  }
}
