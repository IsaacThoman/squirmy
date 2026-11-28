import { describe, expect, it } from 'vitest'
import type { NormalizationMode } from '@squirmy/contracts'
import { appliedGain, gainFor, LIMITER_CEILING_DB } from './normalization.js'

const data = { trackGainDb: -6, albumGainDb: -3, trackPeak: 0.9, albumPeak: 0.95 }
const db = (value: number) => 10 ** (value / 20)
const inAlbum = { albumContext: true, canBoost: false }
const alone = { albumContext: false, canBoost: false }
/** The native engine: it boosts, and limits what that pushes over its ceiling. */
const limited = { canBoost: true, limiter: true }
const modes: NormalizationMode[] = ['off', 'track', 'album', 'auto']

describe('gainFor', () => {
  it('is 1 when off or without data', () => {
    expect(gainFor('off', data, alone)).toBe(1)
    expect(gainFor('auto', null, alone)).toBe(1)
    expect(gainFor('track', { trackGainDb: null, albumGainDb: null, trackPeak: null, albumPeak: null }, alone)).toBe(1)
  })

  it('uses track or album gain by mode', () => {
    expect(gainFor('track', data, inAlbum)).toBeCloseTo(db(-6))
    expect(gainFor('album', data, alone)).toBeCloseTo(db(-3))
  })

  it('auto uses album gain only in album context', () => {
    expect(gainFor('auto', data, inAlbum)).toBeCloseTo(db(-3))
    expect(gainFor('auto', data, alone)).toBeCloseTo(db(-6))
  })

  it('falls back to the other gain when one is missing', () => {
    expect(gainFor('album', { ...data, albumGainDb: null }, alone)).toBeCloseTo(db(-6))
    expect(gainFor('track', { ...data, trackGainDb: null }, alone)).toBeCloseTo(db(-3))
  })

  it('never exceeds 1 / peak', () => {
    expect(gainFor('track', { ...data, trackGainDb: 6, trackPeak: 0.8 }, { albumContext: false, canBoost: true })).toBeCloseTo(1.25)
  })

  it('boosts only when allowed', () => {
    const quiet = { ...data, trackGainDb: 4, trackPeak: 0.2 }
    expect(gainFor('track', quiet, { albumContext: false, canBoost: true })).toBeCloseTo(db(4))
    expect(gainFor('track', quiet, alone)).toBe(1)
  })

  it('ignores a missing or zero peak', () => {
    expect(gainFor('track', { ...data, trackGainDb: 3, trackPeak: null }, { albumContext: false, canBoost: true })).toBeCloseTo(db(3))
    expect(gainFor('track', { ...data, trackGainDb: 3, trackPeak: 0 }, { albumContext: false, canBoost: true })).toBeCloseTo(db(3))
  })
})

describe('gainFor with a target', () => {
  it('moves every mode\'s gain by the target\'s distance from -18 LUFS', () => {
    for (const mode of modes) {
      for (const albumContext of [false, true]) {
        const reference = gainFor(mode, data, { albumContext, ...limited })
        for (const target of [-14, -16, -18, -23]) {
          const expected = mode === 'off' ? 1 : reference * db(target + 18)
          expect(gainFor(mode, data, { albumContext, ...limited, targetLufs: target }), `${mode} at ${target}`).toBeCloseTo(expected)
        }
      }
    }
  })

  it('is -18 LUFS when not given', () => {
    expect(gainFor('track', data, { ...alone, targetLufs: -18 })).toBe(gainFor('track', data, alone))
  })

  it('still holds a louder target back to the peak without a limiter, and to 1 without boost', () => {
    // -6 dB toward -18 is -2 toward -14. A song at -1 dB is +3 toward -14, more than its
    // peak of 0.9 leaves room for.
    expect(gainFor('track', data, { albumContext: false, canBoost: true, targetLufs: -14 })).toBeCloseTo(db(-2))
    expect(gainFor('track', { ...data, trackGainDb: -1 }, { albumContext: false, canBoost: true, targetLufs: -14 })).toBeCloseTo(1 / 0.9)
    expect(gainFor('track', { ...data, trackGainDb: -1 }, { ...alone, targetLufs: -14 })).toBe(1)
    expect(gainFor('track', data, { ...alone, targetLufs: -23 })).toBeCloseTo(db(-11))
  })
})

describe('gainFor with a limiter', () => {
  it('lets the gain past the peak in every mode', () => {
    const loud = { trackGainDb: 6, albumGainDb: 4, trackPeak: 0.8, albumPeak: 0.9 }
    for (const mode of modes) {
      for (const albumContext of [false, true]) {
        const album = mode === 'album' || (mode === 'auto' && albumContext)
        const expected = mode === 'off' ? 1 : db(album ? 4 : 6)
        expect(gainFor(mode, loud, { albumContext, ...limited }), `${mode}, ${albumContext ? 'in its album' : 'alone'}`).toBeCloseTo(expected)
        // Without one, held back to the peak.
        expect(gainFor(mode, loud, { albumContext, canBoost: true })).toBeCloseTo(mode === 'off' ? 1 : 1 / (album ? 0.9 : 0.8))
      }
    }
  })

  it('still never boosts when the output cannot', () => {
    expect(gainFor('track', { ...data, trackGainDb: 6 }, { albumContext: false, canBoost: false, limiter: true })).toBe(1)
  })

  it('turns an estimated gain up only with a limiter', () => {
    const estimated = { trackGainDb: 3, albumGainDb: null, trackPeak: null, albumPeak: null, estimated: true }
    expect(gainFor('track', estimated, { albumContext: false, canBoost: true })).toBe(1)
    expect(gainFor('track', estimated, { albumContext: false, ...limited })).toBeCloseTo(db(3))
    // Turned down, it needs nothing held back.
    expect(gainFor('track', { ...estimated, trackGainDb: -5 }, { albumContext: false, canBoost: true })).toBeCloseTo(db(-5))
    // A tagged gain without a peak is not a guess: it boosts as before.
    expect(gainFor('track', { ...estimated, estimated: false }, { albumContext: false, canBoost: true })).toBeCloseTo(db(3))
  })
})

describe('appliedGain', () => {
  it('says how far the limiter turns the song\'s loudest peak down', () => {
    // A peak of 0.8 (-1.9 dBTP) at +6 dB is 4.1 dBTP: 5.1 dB over the ceiling.
    const loud = { trackGainDb: 6, albumGainDb: 4, trackPeak: 0.8, albumPeak: 0.9 }
    expect(appliedGain('track', loud, { albumContext: false, ...limited }).limitDb).toBeCloseTo(6 + 20 * Math.log10(0.8) - LIMITER_CEILING_DB)
    // At album gain, still the song's own peak.
    expect(appliedGain('album', loud, { albumContext: false, ...limited }).limitDb).toBeCloseTo(4 + 20 * Math.log10(0.8) - LIMITER_CEILING_DB)
    expect(appliedGain('track', data, { albumContext: false, ...limited }).limitDb).toBe(0)
    expect(appliedGain('track', { ...data, trackPeak: null }, { albumContext: false, ...limited }).limitDb).toBeNull()
    // Nothing to say without a limiter, or without a gain.
    expect(appliedGain('track', loud, { albumContext: false, canBoost: true })).not.toHaveProperty('limitDb')
    expect(appliedGain('off', loud, { albumContext: false, ...limited })).toEqual({ gain: 1, applied: null })
  })

  it('names the gain it applies', () => {
    expect(appliedGain('auto', data, inAlbum).applied).toBe('album')
    expect(appliedGain('album', { ...data, albumGainDb: null }, alone).applied).toBe('track')
    expect(appliedGain('off', data, alone)).toEqual({ gain: 1, applied: null })
    expect(appliedGain('track', { trackGainDb: null, albumGainDb: null, trackPeak: null, albumPeak: null }, alone)).toEqual({ gain: 1, applied: null })
  })
})
