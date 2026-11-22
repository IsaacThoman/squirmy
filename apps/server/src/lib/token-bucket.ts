/**
 * A token bucket for limiting a stream of events held in memory, such as one socket's
 * messages: up to `capacity` at once, refilled at `perSecond`. `take` spends a token and
 * returns false when none is left.
 */
export function tokenBucket(options: { capacity: number; perSecond: number; now?: () => number }): { take: () => boolean } {
  const { capacity, perSecond, now = Date.now } = options
  let tokens = capacity
  let last = now()
  return {
    take() {
      const time = now()
      // A clock that steps back refills nothing, and refilling goes on from its new time.
      if (time > last) tokens = Math.min(capacity, tokens + ((time - last) / 1000) * perSecond)
      last = time
      if (tokens < 1) return false
      tokens -= 1
      return true
    },
  }
}
