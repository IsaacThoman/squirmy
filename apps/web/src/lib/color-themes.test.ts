import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { contrastRatio, flattenHex, lightness, mixHex, normalizeHex } from './color'
import {
  COLOR_THEMES, colorThemeStylesheet, DEFAULT_COLOR_THEME_ID, findColorTheme, paletteVariables, resolvePalette, THEME_APPEARANCES, THEME_ROLES,
  type ColorTheme, type ThemeColors, type ThemeRole,
} from './color-themes'

const indexCss = readFileSync(join(import.meta.dirname, '../index.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')

/** The custom properties a CSS block declares. */
function declared(body: string): Record<string, string> {
  return Object.fromEntries([...body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map(([, name, value]) => [name, value.trim()]))
}

/** The colors a top-level block of index.css declares; sizes and other settings are left out. */
function declaredColors(selector: string): Record<string, string> {
  const block = new RegExp(`(?:^|\\n)${selector.replace('.', '\\.')}\\s*\\{([^}]*)\\}`).exec(indexCss)
  if (!block) throw new Error(`index.css has no ${selector} block`)
  return Object.fromEntries(Object.entries(declared(block[1])).filter(([, value]) => normalizeHex(value) !== null))
}

/** What a theme's stylesheet declares for each appearance. */
function stylesheetColors(theme: ColorTheme) {
  const rules = /^:root:not\(\.dark\)\{([^{}]*)\}:root\.dark\{([^{}]*)\}$/.exec(colorThemeStylesheet(theme))
  if (!rules) throw new Error(`${theme.name} has no rule for light, for dark, or has more than those two`)
  return { light: declared(rules[1]), dark: declared(rules[2]) }
}

const defaultTheme = findColorTheme(DEFAULT_COLOR_THEME_ID)
const otherThemes = COLOR_THEMES.filter(theme => theme !== defaultTheme)

describe('the default theme', () => {
  it('is Squirmy, the first in the list', () => {
    expect(COLOR_THEMES[0]).toBe(defaultTheme)
    expect(defaultTheme.name).toBe('Squirmy')
  })

  it('has its light colors written out in the :root block of index.css', () => {
    expect(declaredColors(':root')).toEqual(paletteVariables(resolvePalette(defaultTheme.light)))
  })

  it('has its dark colors written out in the .dark block of index.css', () => {
    expect(declaredColors('.dark')).toEqual(paletteVariables(resolvePalette(defaultTheme.dark)))
  })

  it('needs no stylesheet of its own', () => {
    expect(colorThemeStylesheet(defaultTheme)).toBe('')
  })

  it('has every one of its colors offered to Tailwind by index.css', () => {
    for (const name of Object.keys(paletteVariables(resolvePalette(defaultTheme.light)))) {
      expect(indexCss).toContain(`--color-${name.slice(2)}: var(${name});`)
    }
  })
})

describe('findColorTheme', () => {
  it('finds each theme by its id', () => {
    expect(COLOR_THEMES.map(theme => theme.name)).toEqual(['Squirmy', 'Pulpo', 'Ocean', 'Forest', 'Ember'])
    for (const theme of COLOR_THEMES) expect(findColorTheme(theme.id)).toBe(theme)
  })

  it.each(['neon', '', 'Ocean', null, undefined])('falls back to the default theme for %j', id => {
    expect(findColorTheme(id)).toBe(defaultTheme)
  })
})

describe('colorThemeStylesheet', () => {
  it.each(otherThemes.map(theme => [theme.name, theme] as const))('%s sets its light colors on :root:not(.dark) and its dark colors on :root.dark', (_name, theme) => {
    const colors = stylesheetColors(theme)
    expect(colors.light).toEqual(paletteVariables(resolvePalette(theme.light)))
    expect(colors.dark).toEqual(paletteVariables(resolvePalette(theme.dark)))
    expect(colors.light).not.toEqual(colors.dark)
  })

  it.each(otherThemes.map(theme => [theme.name, theme] as const))('%s replaces every color of index.css, so nothing of the default theme shows through', (_name, theme) => {
    const colors = stylesheetColors(theme)
    expect(Object.keys(colors.light).sort()).toEqual(Object.keys(declaredColors(':root')).sort())
    expect(Object.keys(colors.dark).sort()).toEqual(Object.keys(declaredColors('.dark')).sort())
  })
})

describe('resolvePalette', () => {
  const light: ThemeColors = { background: '#f7fbfe', text: '#0f1d2b', action: '#0b6fbd' }
  const dark: ThemeColors = { background: '#0f1720', text: '#e6f1fa', action: '#4fb0ee' }

  it.each([['light', light], ['dark', dark]] as const)('gives a %s theme of three colors every role', (_name, colors) => {
    const palette = resolvePalette(colors)
    expect(Object.keys(palette).sort()).toEqual([...THEME_ROLES].sort())
    for (const role of THEME_ROLES) expect(normalizeHex(palette[role]), role).toBe(palette[role])
    expect(palette).toMatchObject(colors)
  })

  it('derives a light theme from a light background: surfaces and lines step toward the text', () => {
    const palette = resolvePalette(light)
    const step = (role: ThemeRole) => lightness(palette.background) - lightness(palette[role])
    expect(palette.surface).toBe(palette.background)
    expect(palette.error).toBe('#c81f2a')
    expect(step('sidebar')).toBeGreaterThan(0)
    expect(step('raisedSurface')).toBeGreaterThan(step('sidebar'))
    expect(step('hover')).toBeGreaterThan(step('raisedSurface'))
    expect(step('border')).toBeGreaterThan(step('hover'))
    expect(step('input')).toBeGreaterThan(step('border'))
    expect(lightness(palette.mutedText)).toBeGreaterThan(lightness(palette.text))
    expect(lightness(palette.mutedText)).toBeLessThan(lightness(palette.background))
  })

  it('derives a dark theme from a dark background: surfaces lift toward the text and the sidebar sinks', () => {
    const palette = resolvePalette(dark)
    const lift = (role: ThemeRole) => lightness(palette[role]) - lightness(palette.background)
    expect(palette.error).toBe('#fa5e5a')
    expect(lift('sidebar')).toBeLessThan(0)
    expect(lift('surface')).toBeGreaterThan(0)
    expect(lift('raisedSurface')).toBeGreaterThan(lift('surface'))
    expect(lift('hover')).toBeGreaterThan(lift('raisedSurface'))
    expect(lift('input')).toBeGreaterThan(lift('border'))
    expect(lightness(palette.mutedText)).toBeLessThan(lightness(palette.text))
    expect(lightness(palette.mutedText)).toBeGreaterThan(lightness(palette.background))
  })

  it('goes by the colors, not the slot: dark colors derive as dark wherever a theme puts them', () => {
    const colors = stylesheetColors({ id: 'night', name: 'Night', light: dark, dark })
    expect(colors.light).toEqual(colors.dark)
    expect(colors.light['--destructive']).toBe('#fa5e5a')
  })

  it('writes on the action color in whatever reads best, and focuses in the action color', () => {
    expect(resolvePalette(light).actionText).toBe('#ffffff')
    expect(resolvePalette(dark).actionText).toBe('#000000')
    expect(resolvePalette({ ...light, action: '#ffe45c' }).actionText).toBe('#000000')
    expect(resolvePalette(light).focus).toBe('#0b6fbd')
  })

  it('keeps the colors a theme sets itself', () => {
    const own = { mutedText: '#445566', sidebar: '#eef5fb', actionText: '#f7fbfe', error: '#aa0000' }
    expect(resolvePalette({ ...light, ...own })).toMatchObject(own)
  })

  it('flattens translucent fills and text onto the background, and leaves lines translucent', () => {
    const palette = resolvePalette({ background: '#000000', text: '#ffffff80', action: '#ffffffff', surface: '#ffffff80', border: '#ffffff17', sidebarBorder: '#ffffff14' })
    expect(palette).toMatchObject({ text: '#808080', surface: '#808080', action: '#ffffff', border: '#ffffff17', sidebarBorder: '#ffffff14' })
  })
})

describe('paletteVariables', () => {
  it('writes on the error color in black or white, whichever reads better', () => {
    expect(paletteVariables(resolvePalette(defaultTheme.light))['--destructive-foreground']).toBe('#ffffff')
    expect(paletteVariables(resolvePalette(defaultTheme.dark))['--destructive-foreground']).toBe('#000000')
  })
})

/** WCAG AA for body text. */
const READABLE = 4.5

describe('readability', () => {
  const cases = COLOR_THEMES.flatMap(theme => THEME_APPEARANCES.flatMap(appearance => {
    const palette = resolvePalette(theme[appearance])
    return [
      ['text on the background', palette.text, palette.background],
      ['text on cards', palette.text, palette.surface],
      ['text on the sidebar', palette.text, palette.sidebar],
      ['muted text on the background', flattenHex(palette.mutedText, palette.background), palette.background],
      ['action text on the action color', palette.actionText, palette.action],
      // The "Playing on …" and "Only on this device" strips: text on a 10 % tint of the action color.
      ['text on the action tint', palette.text, mixHex(palette.background, palette.action, 0.1)],
    ].map(([pair, text, behind]) => [theme.name, appearance, pair, text, behind] as const)
  }))

  it.each(cases)('%s %s: %s has a contrast of 4.5:1 or more (%s on %s)', (_theme, _appearance, _pair, text, behind) => {
    expect(contrastRatio(text, behind)).toBeGreaterThanOrEqual(READABLE)
  })
})

describe('readability of muted text on the surfaces it sits on', () => {
  /** Where `text-muted-foreground` is drawn besides the page: quiet fills, the hovered or active row, the sidebar and its selected row. */
  const surfaces = { 'quiet fills': 'raisedSurface', 'the hovered row': 'hover', 'the sidebar': 'sidebar', 'the selected sidebar row': 'sidebarSelection' } as const
  const failing = new Set<string>([])
  const cases = COLOR_THEMES.flatMap(theme => THEME_APPEARANCES.flatMap(appearance => {
    const palette = resolvePalette(theme[appearance])
    return Object.entries(surfaces).map(([surface, role]) => {
      const behind = flattenHex(palette[role], palette.background)
      return [`${theme.name} ${appearance} ${surface}`, flattenHex(palette.mutedText, behind), behind] as const
    })
  }))
  const check = (_case: string, text: string, behind: string) => {
    expect(contrastRatio(text, behind)).toBeGreaterThanOrEqual(READABLE)
  }

  it.each(cases.filter(([name]) => !failing.has(name)))('%s: has a contrast of 4.5:1 or more (%s on %s)', check)
  it.fails.each(cases.filter(([name]) => failing.has(name)))('%s: has a contrast of 4.5:1 or more (%s on %s)', check)

  it('names only cases that exist', () => {
    for (const name of failing) expect(cases.map(([each]) => each)).toContain(name)
  })
})
