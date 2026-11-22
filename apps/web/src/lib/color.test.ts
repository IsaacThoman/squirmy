import { describe, expect, it } from 'vitest'
import { alphaOf, contrastRatio, flattenHex, lightness, mixHex, mostReadable, normalizeHex, solidHex } from './color'

describe('normalizeHex', () => {
  it('writes every form of a hex color as lower-case #rrggbb', () => {
    expect(normalizeHex('#ABC')).toBe('#aabbcc')
    expect(normalizeHex('abc')).toBe('#aabbcc')
    expect(normalizeHex('  #1D1929 ')).toBe('#1d1929')
    expect(normalizeHex('1d1929')).toBe('#1d1929')
  })

  it('keeps the alpha of a translucent color and drops one that is fully opaque', () => {
    expect(normalizeHex('#abc8')).toBe('#aabbcc88')
    expect(normalizeHex('#FFFFFF17')).toBe('#ffffff17')
    expect(normalizeHex('#abcf')).toBe('#aabbcc')
    expect(normalizeHex('#112233FF')).toBe('#112233')
  })

  it.each(['', '#', 'red', '#12', '#12345', '#1234567', '#123456789', '#gggggg', 'rgb(0, 0, 0)'])('rejects %j', value => {
    expect(normalizeHex(value)).toBeNull()
  })
})

describe('solidHex and alphaOf', () => {
  it('split a color into its opaque part and its alpha', () => {
    expect(solidHex('#ffffff80')).toBe('#ffffff')
    expect(alphaOf('#ffffff80')).toBeCloseTo(128 / 255)
    expect(alphaOf('#00000000')).toBe(0)
    expect(solidHex('#1d1929')).toBe('#1d1929')
    expect(alphaOf('#1d1929')).toBe(1)
  })

  it('read something that is not a color as opaque black', () => {
    expect(solidHex('nonsense')).toBe('#000000')
    expect(alphaOf('nonsense')).toBe(1)
  })
})

describe('flattenHex', () => {
  it('leaves an opaque color as it is, whatever is behind it', () => {
    expect(flattenHex('#B5368F', '#000000')).toBe('#b5368f')
    expect(flattenHex('#b5368fff', '#ffffff')).toBe('#b5368f')
  })

  it('paints a translucent color over the background', () => {
    expect(flattenHex('#ffffff80', '#000000')).toBe('#808080')
    expect(flattenHex('#00000080', '#ffffff')).toBe('#7f7f7f')
    expect(flattenHex('#ff000040', '#0000ff')).toBe('#4000bf')
  })

  it('shows only the background through a fully transparent color', () => {
    expect(flattenHex('#ffffff00', '#123456')).toBe('#123456')
  })

  it('ignores the background’s own alpha', () => {
    expect(flattenHex('#ffffff80', '#00000010')).toBe('#808080')
  })
})

describe('mixHex', () => {
  it.each([
    ['#000000', '#ffffff'],
    ['#fbf9ff', '#1d1929'],
    ['#b5368f', '#4fb0ee'],
  ])('gives %s at 0 and %s at 1', (from, to) => {
    expect(mixHex(from, to, 0)).toBe(from)
    expect(mixHex(from, to, 1)).toBe(to)
  })

  it('moves evenly in lightness between the two colors', () => {
    const middle = mixHex('#000000', '#ffffff', 0.5)
    expect(lightness(middle)).toBeCloseTo(0.5, 2)
    // Halfway between black and white there is no hue.
    expect(new Set([middle.slice(1, 3), middle.slice(3, 5), middle.slice(5, 7)]).size).toBe(1)
    expect(lightness(mixHex('#000000', '#ffffff', 0.25))).toBeLessThan(lightness(middle))
  })

  it('moves away from the second color for a negative amount', () => {
    expect(lightness(mixHex('#202020', '#ffffff', -0.05))).toBeLessThan(lightness('#202020'))
  })

  it('stays a displayable color when the mix leaves the sRGB range', () => {
    expect(mixHex('#000000', '#ffffff', -0.5)).toBe('#000000')
    expect(mixHex('#000000', '#ffffff', 1.5)).toBe('#ffffff')
  })
})

describe('lightness', () => {
  it('runs from 0 for black to 1 for white', () => {
    expect(lightness('#000000')).toBeCloseTo(0, 5)
    expect(lightness('#ffffff')).toBeCloseTo(1, 5)
    expect(lightness('#1d1929')).toBeLessThan(lightness('#fbf9ff'))
  })
})

describe('contrastRatio', () => {
  it('is 21 between black and white and 1 between a color and itself', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 10)
    expect(contrastRatio('#b5368f', '#b5368f')).toBe(1)
  })

  it('does not depend on which color is the text', () => {
    expect(contrastRatio('#1d1929', '#fbf9ff')).toBe(contrastRatio('#fbf9ff', '#1d1929'))
  })

  it('matches the WCAG ratio of a known pair', () => {
    // #767676 is the lightest gray that passes AA on white.
    expect(contrastRatio('#767676', '#ffffff')).toBeCloseTo(4.54, 2)
    expect(contrastRatio('#777777', '#ffffff')).toBeLessThan(4.5)
  })
})

describe('mostReadable', () => {
  it('picks the candidate with the most contrast against the background', () => {
    expect(mostReadable('#1d1929', ['#ffffff', '#000000'])).toBe('#ffffff')
    expect(mostReadable('#f099d8', ['#ffffff', '#000000'])).toBe('#000000')
    expect(mostReadable('#0b6fbd', ['#0f1d2b', '#f7fbfe', '#888888'])).toBe('#f7fbfe')
  })

  it('keeps the earlier of two candidates that read equally well', () => {
    expect(mostReadable('#000000', ['#ffffff', '#fff'])).toBe('#ffffff')
  })
})
