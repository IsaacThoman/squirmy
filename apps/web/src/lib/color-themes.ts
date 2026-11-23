import { clampLightness, contrastRatio, flattenHex, lightness, mixHex, mostReadable, solidHex } from './color'

/**
 * Color themes. A theme gives each appearance (light and dark) a few colors; every color it
 * leaves out is derived from its background, text and action colors, so a theme can be three
 * colors per appearance.
 *
 * The default theme's colors are also written out in `index.css`, which is what shows before
 * this code runs. `color-themes.test.ts` fails when the two drift apart.
 */
export const THEME_ROLES = [
  'background', 'surface', 'raisedSurface', 'hover', 'text', 'mutedText', 'border', 'input',
  'action', 'actionText', 'focus', 'sidebar', 'sidebarSelection', 'sidebarBorder', 'error',
] as const
export type ThemeRole = (typeof THEME_ROLES)[number]

export const THEME_APPEARANCES = ['light', 'dark'] as const
export type ThemeAppearance = (typeof THEME_APPEARANCES)[number]

/** The colors every theme sets itself. */
type BaseColors = Record<'background' | 'text' | 'action', string>
export type ThemeColors = BaseColors & Partial<Record<ThemeRole, string>>
export type ThemePalette = Record<ThemeRole, string>

export type ColorTheme = {
  id: string
  name: string
  light: ThemeColors
  dark: ThemeColors
}

export const DEFAULT_COLOR_THEME_ID = 'squirmy'

/** Names are product names, so they stay as they are in every language. */
export const COLOR_THEMES: readonly ColorTheme[] = [
  {
    id: DEFAULT_COLOR_THEME_ID,
    name: 'Squirmy',
    light: {
      background: '#fbf9ff', surface: '#ffffff', raisedSurface: '#f1edf9', hover: '#ebe5f7', text: '#1d1929', mutedText: '#67607c',
      border: '#e2dbf0', action: '#b5368f', focus: '#7c5ce0',
      sidebar: '#f4f0fc', sidebarSelection: '#e6ddf8', sidebarBorder: '#e2dbf0', error: '#c42e3a',
    },
    dark: {
      background: '#1d1929', surface: '#231e31', raisedSurface: '#383443', hover: '#403c4b', text: '#fffaff', mutedText: '#aca6b5',
      border: '#4d4366', action: '#f099d8', focus: '#9d7df2',
      sidebar: '#272139', sidebarSelection: '#3d325d', sidebarBorder: '#362d51', error: '#fe5a5e',
    },
  },
  {
    id: 'pulpo',
    name: 'Pulpo',
    light: {
      background: '#ffffff', surface: '#ffffff', raisedSurface: '#f4f4f5', hover: '#f4f4f5', text: '#09090b', mutedText: '#686872',
      border: '#e4e4e7', action: '#18181b', actionText: '#fafafa', focus: '#71717b',
      sidebar: '#fafafa', sidebarSelection: '#f4f4f5', sidebarBorder: '#e4e4e7', error: '#cd000f',
    },
    dark: {
      background: '#0d0d0f', surface: '#131316', raisedSurface: '#212124', hover: '#262629', text: '#fafafa', mutedText: '#9f9fa9',
      border: '#ffffff17', action: '#e4e4e7', actionText: '#18181b', focus: '#71717b',
      sidebar: '#111114', sidebarSelection: '#212124', sidebarBorder: '#ffffff14', error: '#f84b4e',
    },
  },
  {
    id: 'ocean',
    name: 'Ocean',
    light: { background: '#f7fbfe', text: '#0f1d2b', action: '#0b6fbd', sidebar: '#eef5fb' },
    dark: { background: '#0f1720', text: '#e6f1fa', action: '#4fb0ee', sidebar: '#0c131b' },
  },
  {
    id: 'forest',
    name: 'Forest',
    light: { background: '#f8fbf8', text: '#14231a', action: '#1d7f4a', sidebar: '#eef5ef' },
    dark: { background: '#121a16', text: '#e7f2ea', action: '#5cc48a', sidebar: '#0f1612' },
  },
  {
    id: 'ember',
    name: 'Ember',
    light: { background: '#fffaf6', text: '#2a1a12', action: '#bd4f18', sidebar: '#fbf1ea' },
    dark: { background: '#1c1512', text: '#fbefe8', action: '#f08a4b', sidebar: '#18110e' },
  },
]

/** The theme with this id, or the default when the id is unknown (a theme that was removed). */
export function findColorTheme(id: string | null | undefined): ColorTheme {
  return COLOR_THEMES.find(theme => theme.id === id) ?? COLOR_THEMES[0]
}

/** Painted as a solid fill, so a translucent color is flattened onto the background. */
const OPAQUE: ReadonlySet<ThemeRole> = new Set(['background', 'surface', 'raisedSurface', 'text', 'action', 'actionText', 'sidebar'])

/**
 * WCAG's minimum for what identifies a control that has no words of its own (a text field's edge,
 * a slider's track): 3:1 against what is around it.
 */
export const NON_TEXT_CONTRAST = 3

/** The surfaces a control can sit on: the page, cards and dialogs, quiet fills, the sidebar and the player. */
export const CONTROL_SURFACES = ['background', 'surface', 'raisedSurface', 'sidebar'] as const satisfies readonly ThemeRole[]

/**
 * `from` with as little of `to` mixed in as stands `ratio`:1 apart from each of `against`. The
 * search runs on the rounded colors, so the answer passes as written.
 */
function leastMix(from: string, to: string, against: readonly string[], ratio: number): string {
  const passes = (amount: number) => against.every(color => contrastRatio(mixHex(from, to, amount), color) >= ratio)
  let low = 0
  let high = 1
  for (let step = 0; step < 24; step++) {
    const middle = (low + high) / 2
    if (passes(middle)) high = middle
    else low = middle
  }
  return mixHex(from, to, high)
}

/**
 * How a color the theme leaves out follows its background, text and action colors (and its
 * sidebar, for what sits on it). Muted text is as light as it can be while it still reads at
 * 4.5:1 on every surface it is drawn on: quiet fills, hovered and selected rows, the sidebar.
 * `resolved` holds the roles before this one in `THEME_ROLES`.
 */
function derivedColor(role: ThemeRole, { background, text, action, sidebar }: BaseColors & { sidebar: string }, dark: boolean, resolved: Partial<ThemePalette>): string {
  switch (role) {
    // Cards and menus lift off a dark page enough to show over the sidebar; a light page stays flat.
    case 'surface': return dark ? mixHex(background, text, 0.05) : background
    case 'raisedSurface': return mixHex(background, text, dark ? 0.09 : 0.045)
    case 'hover': return mixHex(background, text, dark ? 0.11 : 0.06)
    case 'mutedText': return mixHex(text, background, 0.35)
    case 'border': return mixHex(background, text, 0.1)
    // The edge of an empty text field, a select and a slider's track: nothing else shows where they
    // are, so it stands 3:1 off every surface they sit on, and no further, to stay quiet.
    case 'input': return leastMix(background, text, CONTROL_SURFACES.map(surface => resolved[surface] ?? background), NON_TEXT_CONTRAST + 0.05)
    case 'actionText': return mostReadable(action, ['#ffffff', background, text, '#000000'])
    case 'focus': return action
    // Dark sidebars sit a touch below the page (a negative mix extrapolates past the background).
    case 'sidebar': return mixHex(background, text, dark ? -0.015 : 0.02)
    // From the sidebar, not the page: a sidebar darker than the page would otherwise swallow it.
    case 'sidebarSelection': return mixHex(sidebar, text, dark ? 0.09 : 0.065)
    case 'sidebarBorder': return mixHex(background, text, dark ? 0.08 : 0.09)
    // Readable on its own 10 % tint, as form errors and danger badges draw it.
    case 'error': return dark ? '#fa5e5a' : '#c81f2a'
    case 'background': return background
    case 'text': return text
    case 'action': return action
  }
}

/** Every role's color for one appearance: the theme's own colors, else derived from its base colors. */
export function resolvePalette(colors: ThemeColors): ThemePalette {
  const background = solidHex(colors.background)
  const base = { background, text: flattenHex(colors.text, background), action: flattenHex(colors.action, background) }
  // Follows the colors themselves, so a dark palette derives sensibly whichever appearance holds it.
  const dark = lightness(base.background) < lightness(base.text)
  const sidebar = flattenHex(colors.sidebar ?? derivedColor('sidebar', { ...base, sidebar: background }, dark, {}), background)
  const palette: Partial<ThemePalette> = { sidebar }
  for (const role of THEME_ROLES) {
    const color = role in base ? base[role as keyof BaseColors] : colors[role] ?? derivedColor(role, { ...base, sidebar }, dark, palette)
    palette[role] = OPAQUE.has(role) ? flattenHex(color, background) : color
  }
  return palette as ThemePalette
}

/**
 * How light an artwork's color may be when it tints a dark page's header (OKLab lightness). The
 * dark tint is strong (`--album-tint`), and a pale cover would otherwise lift the header until its
 * secondary text no longer reads; `color-themes.test.ts` checks every theme against pale, vivid
 * and dark covers. Light pages tint weakly enough to take any color.
 */
export const DARK_TINT_MAX_LIGHTNESS = 0.6

/** The colors that tint a collection header in light and in dark mode. */
export function headerTints(color: string): { light: string; dark: string } {
  return { light: color, dark: clampLightness(color, 0, DARK_TINT_MAX_LIGHTNESS) }
}

/** The palette as the CSS custom properties `index.css` declares. */
export function paletteVariables(palette: ThemePalette): Record<string, string> {
  return {
    '--background': palette.background,
    '--foreground': palette.text,
    '--card': palette.surface,
    '--card-foreground': palette.text,
    '--popover': palette.surface,
    '--popover-foreground': palette.text,
    '--primary': palette.action,
    '--primary-foreground': palette.actionText,
    '--secondary': palette.raisedSurface,
    '--secondary-foreground': palette.text,
    '--muted': palette.raisedSurface,
    '--muted-foreground': palette.mutedText,
    '--accent': palette.hover,
    '--accent-foreground': palette.text,
    '--destructive': palette.error,
    '--destructive-foreground': mostReadable(solidHex(palette.error), ['#ffffff', '#000000']),
    '--border': palette.border,
    '--input': palette.input,
    '--ring': palette.focus,
    '--sidebar': palette.sidebar,
    '--sidebar-foreground': palette.text,
    '--sidebar-accent': palette.sidebarSelection,
    '--sidebar-accent-foreground': palette.text,
    '--sidebar-border': palette.sidebarBorder,
  }
}

function declarations(colors: ThemeColors): string {
  return Object.entries(paletteVariables(resolvePalette(colors))).map(([name, value]) => `${name}:${value};`).join('')
}

/**
 * The stylesheet that applies a theme: its colors for each appearance. The default theme yields
 * nothing, so `index.css` applies untouched.
 */
export function colorThemeStylesheet(theme: ColorTheme): string {
  if (theme.id === DEFAULT_COLOR_THEME_ID) return ''
  // :root plus a class outranks the `:root` and `.dark` blocks of index.css whatever the load order.
  return `:root:not(.dark){${declarations(theme.light)}}:root.dark{${declarations(theme.dark)}}`
}
