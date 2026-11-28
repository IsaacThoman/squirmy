import { describe, expect, it } from 'vitest'
import { isApplePlatform } from './platform'

describe('isApplePlatform', () => {
  it('knows a Mac by its client hint as well as by navigator.platform', () => {
    // Chrome on a Mac says "macOS" in `userAgentData.platform`; Safari and Firefox say "MacIntel".
    expect(['macOS', 'MacIntel', 'iPhone', 'iPad'].map(isApplePlatform)).toEqual([true, true, true, true])
    expect(['Windows', 'Linux', 'Android', 'Chrome OS', 'Win32'].map(isApplePlatform)).toEqual([false, false, false, false, false])
  })
})
