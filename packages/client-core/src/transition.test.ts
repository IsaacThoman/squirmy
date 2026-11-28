import { describe, expect, it } from 'vitest'
import { crossfadePlan, SMART_SHORTEST_MS } from './transition.js'

const timing = (overrides: Partial<{ audibleStartMs: number; audibleEndMs: number; introEndMs: number; outroStartMs: number }>) => ({
  bpm: null, beatOffsetMs: null, audibleStartMs: null, audibleEndMs: null, introEndMs: null, outroStartMs: null, ...overrides,
})

// The same cases as the Swift engine's `TransitionPlanTests`: the two must agree.
describe('crossfade plan', () => {
  const plain = { seconds: 6, smart: false }
  const smart = { seconds: 6, smart: true }

  it('fades over the length set, no more than half of either song, at the ends of the files without timing', () => {
    expect(crossfadePlan({ durationMs: 200_000 }, { durationMs: 180_000 }, plain)).toEqual({ fadeMs: 6000, outgoingEndMs: 200_000, incomingStartMs: 0 })
    expect(crossfadePlan({ durationMs: 8000 }, { durationMs: 180_000 }, plain).fadeMs).toBe(4000)
    expect(crossfadePlan({ durationMs: 200_000 }, { durationMs: 5000 }, plain).fadeMs).toBe(2500)
    expect(crossfadePlan({ durationMs: 200_000 }, { durationMs: null }, plain).fadeMs).toBe(6000)
    // Smart transitions without timing are the plain crossfade.
    expect(crossfadePlan({ durationMs: 200_000 }, { durationMs: 180_000 }, smart)).toEqual({ fadeMs: 6000, outgoingEndMs: 200_000, incomingStartMs: 0 })
  })

  it('skips the silence after the outgoing song and before the incoming one', () => {
    const plan = crossfadePlan(
      { durationMs: 200_000, timing: timing({ audibleEndMs: 196_500 }) },
      { durationMs: 180_000, timing: timing({ audibleStartMs: 700 }) },
      plain,
    )
    expect(plan).toEqual({ fadeMs: 6000, outgoingEndMs: 196_500, incomingStartMs: 700 })
  })

  it('ignores timing that does not fit the song', () => {
    const plan = crossfadePlan(
      { durationMs: 200_000, timing: timing({ audibleEndMs: 50_000, outroStartMs: 10_000 }) },
      { durationMs: 180_000, timing: timing({ audibleStartMs: 120_000, introEndMs: 150_000 }) },
      smart,
    )
    expect(plan).toEqual({ fadeMs: 6000, outgoingEndMs: 200_000, incomingStartMs: 0 })
  })

  it('with Smart transitions, mixes over the longer of the outro and the intro, within the length set', () => {
    const fadesOut = { durationMs: 200_000, timing: timing({ audibleEndMs: 199_000, outroStartMs: 195_000 }) }
    const hardStart = { durationMs: 180_000, timing: timing({ audibleStartMs: 100, introEndMs: 300 }) }
    expect(crossfadePlan(fadesOut, hardStart, smart)).toEqual({ fadeMs: 4000, outgoingEndMs: 199_000, incomingStartMs: 100 })
    const slowIntro = { durationMs: 180_000, timing: timing({ audibleStartMs: 0, introEndMs: 5000 }) }
    expect(crossfadePlan(fadesOut, slowIntro, smart).fadeMs).toBe(5000)
    // A long fade-out is mixed over its last part, as long as the setting.
    const longFade = { durationMs: 200_000, timing: timing({ audibleEndMs: 199_000, outroStartMs: 170_000 }) }
    expect(crossfadePlan(longFade, hardStart, smart).fadeMs).toBe(6000)
    // Two hard edges: a short blend.
    const hardEnd = { durationMs: 200_000, timing: timing({ audibleEndMs: 199_900, outroStartMs: 199_700 }) }
    expect(crossfadePlan(hardEnd, hardStart, smart)).toEqual({ fadeMs: SMART_SHORTEST_MS, outgoingEndMs: 199_900, incomingStartMs: 100 })
    // Never longer than the length set, even when that is shorter than the shortest.
    expect(crossfadePlan(hardEnd, hardStart, { seconds: 0.5, smart: true }).fadeMs).toBe(500)
  })
})
