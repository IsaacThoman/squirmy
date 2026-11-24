import { formatDuration, formatRemaining } from '@/lib/format'
import { describe, expect, it } from 'vitest'
import { progressPosition, seekBarPosition } from './progress'

describe('progressPosition', () => {
  it('holds the bar between steps of a 3000th of the track', () => {
    // A 4 minute track: steps of 80 ms.
    expect(progressPosition(0, 240_000)).toBe(0)
    expect(progressPosition(79, 240_000)).toBe(0)
    expect(progressPosition(80, 240_000)).toBe(80)
    expect(progressPosition(1_234, 240_000)).toBe(1_200)
  })

  it('is never ahead of the music', () => {
    for (const position of [0, 17, 999, 61_005, 239_999]) expect(progressPosition(position, 240_000)).toBeLessThanOrEqual(position)
  })

  it('passes the position through when there is no duration', () => {
    expect(progressPosition(1_234, 0)).toBe(1_234)
  })
})

describe('seekBarPosition', () => {
  it('shows the clocks as they would read the exact position', () => {
    // Lengths that are not whole seconds turn the remaining clock between the elapsed one's turns.
    for (const duration of [240_000, 183_457, 3_210]) {
      for (let position = 0; position <= duration; position += 7) {
        const shown = seekBarPosition(position, duration)
        expect(formatDuration(shown)).toBe(formatDuration(position))
        expect(formatRemaining(shown, duration)).toBe(formatRemaining(position, duration))
      }
    }
  })

  it('moves the bar by less than a 3000th of the track', () => {
    for (let position = 0; position <= 183_457; position += 13) {
      const shown = seekBarPosition(position, 183_457)
      expect(shown).toBeLessThanOrEqual(position)
      expect(position - shown).toBeLessThan(183_457 / 3000)
    }
  })

  it('changes a few times a second, not on every frame', () => {
    const shown = new Set<number>()
    // One second of 60 Hz frames at the start of a 4 minute track.
    for (let frame = 0; frame < 60; frame += 1) shown.add(seekBarPosition(30_000 + frame * (1000 / 60), 240_000))
    expect(shown.size).toBeLessThanOrEqual(14)
  })
})
