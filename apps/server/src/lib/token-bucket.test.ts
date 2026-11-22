import { describe, expect, it } from 'vitest'
import { tokenBucket } from './token-bucket.js'

describe('tokenBucket', () => {
  it('allows a burst, then refills at the rate, never past the capacity', () => {
    let time = 0
    const bucket = tokenBucket({ capacity: 3, perSecond: 2, now: () => time })
    expect([bucket.take(), bucket.take(), bucket.take(), bucket.take()]).toEqual([true, true, true, false])
    time += 499
    expect(bucket.take()).toBe(false)
    time += 1
    expect([bucket.take(), bucket.take()]).toEqual([true, false])
    time += 60_000
    expect([bucket.take(), bucket.take(), bucket.take(), bucket.take()]).toEqual([true, true, true, false])
  })

  it('does not gain tokens from a clock that goes back', () => {
    let time = 10_000
    const bucket = tokenBucket({ capacity: 1, perSecond: 1, now: () => time })
    expect(bucket.take()).toBe(true)
    time = 0
    expect(bucket.take()).toBe(false)
    time = 999
    expect(bucket.take()).toBe(false)
    time = 1000
    expect(bucket.take()).toBe(true)
  })
})
