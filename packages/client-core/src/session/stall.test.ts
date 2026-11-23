import { describe, expect, it } from 'vitest'
import { STALL_SETTLED_MS, STALL_WAITS_MS, StallWatchdog, type StallReading } from './stall.js'

const reading = (waiting: StallReading['waiting'], extra: Partial<StallReading> = {}): StallReading => ({
  entryId: 'e1', trackId: 't1', waiting, playing: waiting === null, canGiveUp: true, ...extra,
})

/** Checks once a second from `from` to `to` (exclusive) and returns what was asked, with the time. */
function run(watchdog: StallWatchdog, read: (t: number) => StallReading | null, from: number, to: number) {
  const actions: string[] = []
  for (let t = from; t < to; t += 1000) {
    const action = watchdog.check(read(t), t)
    if (action) actions.push(`${t / 1000}s ${action.type}${'attempt' in action ? ` ${action.attempt}` : ` after ${action.attempts}`} (${action.state}, ${action.stuckMs / 1000}s)`)
  }
  return actions
}

describe('StallWatchdog', () => {
  it('reloads after 6 s, then waits longer each time, then gives up', () => {
    const actions = run(new StallWatchdog(), () => reading('loading'), 0, 60_000)
    expect(STALL_WAITS_MS).toEqual([6000, 8000, 12000, 16000])
    expect(actions).toEqual([
      '6s recover 1 (loading, 6s)',
      '14s recover 2 (loading, 14s)',
      '26s recover 3 (loading, 26s)',
      '42s giveUp after 3 (loading, 42s)',
    ])
  })

  it('leaves a song that plays, or that starts within the first wait, alone', () => {
    const watchdog = new StallWatchdog()
    expect(run(watchdog, t => reading(t < 5000 ? 'loading' : null), 0, 30_000)).toEqual([])
    expect(run(watchdog, t => reading(t < 35_000 ? 'buffering' : null), 30_000, 60_000)).toEqual([])
  })

  it('says once when a reloaded song plays again, with how long it was stuck', () => {
    const watchdog = new StallWatchdog()
    expect(run(watchdog, t => reading(t < 9000 ? 'resolving' : null), 0, 20_000)).toEqual([
      '6s recover 1 (resolving, 6s)',
      '9s recovered after 1 (resolving, 9s)',
    ])
  })

  it('keeps escalating for a stream that breaks again soon after each reload, and starts over once it has played a while', () => {
    const watchdog = new StallWatchdog()
    // Each reload plays for 3 s, then the stream stalls for good again.
    let reloadedAt = -Infinity
    const actions: string[] = []
    for (let t = 0; t < 80_000; t += 1000) {
      const action = watchdog.check(reading(t - reloadedAt < 3000 ? null : 'buffering'), t)
      if (action?.type === 'recover') reloadedAt = t + 1000
      if (action) actions.push(`${t / 1000}s ${action.type}`)
    }
    expect(actions).toEqual(['6s recover', '7s recovered', '18s recover', '19s recovered', '34s recover', '35s recovered', '54s giveUp'])

    const steady = new StallWatchdog()
    run(steady, t => reading(t < 7000 ? 'buffering' : null), 0, 7000 + STALL_SETTLED_MS + 1000)
    // A new stall after a good stretch gets the full first wait again.
    expect(run(steady, () => reading('buffering'), 20_000, 27_000)).toEqual(['26s recover 1 (buffering, 6s)'])
  })

  it('never gives up while the server cannot be reached, and reloads at the longest wait instead', () => {
    const actions = run(new StallWatchdog(), () => reading('loading', { canGiveUp: false }), 0, 80_000)
    expect(actions).toEqual([
      '6s recover 1 (loading, 6s)',
      '14s recover 2 (loading, 14s)',
      '26s recover 3 (loading, 26s)',
      '42s recover 3 (loading, 42s)',
      '58s recover 3 (loading, 58s)',
      '74s recover 3 (loading, 74s)',
    ])
  })

  it('forgets the watch when nothing should play, and watches a new entry from the start', () => {
    const watchdog = new StallWatchdog()
    run(watchdog, () => reading('loading'), 0, 15_000)
    expect(watchdog.check(null, 15_000)).toBeNull()
    expect(run(watchdog, () => reading('loading'), 16_000, 23_000)).toEqual(['22s recover 1 (loading, 6s)'])
    expect(run(watchdog, () => reading('loading', { entryId: 'e2' }), 23_000, 30_000)).toEqual(['29s recover 1 (loading, 6s)'])
  })

  it('does not count a pause as a stall', () => {
    const watchdog = new StallWatchdog()
    expect(run(watchdog, () => reading(null, { playing: false }), 0, 60_000)).toEqual([])
  })
})
