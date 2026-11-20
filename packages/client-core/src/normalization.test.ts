import { describe, expect, it } from 'vitest'
import { gainFor } from './normalization.js'

const data = { trackGainDb: -6, albumGainDb: -3, trackPeak: 0.9, albumPeak: 0.95 }
const db = (value: number) => 10 ** (value / 20)
const inAlbum = { albumContext: true, canBoost: false }
const alone = { albumContext: false, canBoost: false }

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
