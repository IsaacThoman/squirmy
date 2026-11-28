import type { ThemeAppearance } from './color-themes'

/**
 * How Now Playing's ambient backdrop is held toward the page so the theme's text reads over any
 * cover: drawn at `opacity` over the background, after darkening by `shade` (black laid over it).
 */
export const AMBIENT_HOLD: Record<ThemeAppearance, { opacity: number; shade: number }> = {
  light: { opacity: 0.5, shade: 0 },
  dark: { opacity: 0.7, shade: 0.4 },
}

/** The theme's background over the backdrop, as shares of it from the top down (`wash` in now-playing.css). */
export const AMBIENT_WASH = { top: 0.55, middle: 0.8 } as const

/** How much more colorful than the cover the backdrop is, as CSS `saturate()` counts. */
export const AMBIENT_SATURATION = 2

type Rgb = [number, number, number]

const hex = (value: string): Rgb => [1, 3, 5].map(at => Number.parseInt(value.slice(at, at + 2), 16)) as Rgb
const toHex = (rgb: Rgb) => `#${rgb.map(channel => Math.round(Math.max(0, Math.min(255, channel))).toString(16).padStart(2, '0')).join('')}`
const blend = (top: Rgb, bottom: Rgb, alpha: number): Rgb => top.map((channel, index) => channel * alpha + bottom[index]! * (1 - alpha)) as Rgb

/** One color made `amount` times as colorful, by the matrix CSS `saturate()` uses. */
function saturated([r, g, b]: Rgb, amount: number): Rgb {
  return [
    (0.213 + 0.787 * amount) * r + (0.715 - 0.715 * amount) * g + (0.072 - 0.072 * amount) * b,
    (0.213 - 0.213 * amount) * r + (0.715 + 0.285 * amount) * g + (0.072 - 0.072 * amount) * b,
    (0.213 - 0.213 * amount) * r + (0.715 - 0.715 * amount) * g + (0.072 + 0.928 * amount) * b,
  ]
}

/** Makes RGBA pixels `amount` times as colorful, in place: the backdrop is drawn colorful once, so no filter runs per frame. */
export function saturatePixels(rgba: Uint8ClampedArray | Uint8Array, amount = AMBIENT_SATURATION): void {
  for (let at = 0; at < rgba.length; at += 4) {
    const [r, g, b] = saturated([rgba[at]!, rgba[at + 1]!, rgba[at + 2]!], amount)
    rgba[at] = Math.max(0, Math.min(255, Math.round(r)))
    rgba[at + 1] = Math.max(0, Math.min(255, Math.round(g)))
    rgba[at + 2] = Math.max(0, Math.min(255, Math.round(b)))
  }
}

/**
 * The color behind Now Playing's text where a cover of `cover`'s color spreads under it, `wash`
 * of the way down the backdrop's wash: what the contrast tests check the theme's text against.
 */
export function ambientBehind(cover: string, background: string, appearance: ThemeAppearance, wash: number = AMBIENT_WASH.top): string {
  const { opacity, shade } = AMBIENT_HOLD[appearance]
  const page = hex(background)
  const art = blend([0, 0, 0], saturated(hex(cover), AMBIENT_SATURATION).map(channel => Math.max(0, Math.min(255, channel))) as Rgb, shade)
  return toHex(blend(page, blend(art, page, opacity), wash))
}
