/**
 * Text of a song that doesn't play for the viewer. The row is gray on purpose, but it must
 * still read: each color keeps at least 3:1 against the page and the highlighted current row,
 * as web does (#129). Only the artwork is dimmed further, and the row's heart and menu keep
 * their full color, since they still work.
 */
export const fadedText = {
  dark: { title: '#8E8B96', credit: '#77727F' },
  light: { title: '#75707F', credit: '#8B8595' },
} as const;

/** How far a gray row's artwork (cover or track number) fades. */
export const fadedArtOpacity = 0.42;

function channel(value: number): number {
  const c = value / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map(at => channel(parseInt(hex.slice(at, at + 2), 16)));
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

/** The WCAG contrast ratio of two opaque `#RRGGBB` colors. */
export function contrastRatio(a: string, b: string): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light! + 0.05) / (dark! + 0.05);
}

/** `top` with `alpha` over `under`, for a translucent highlight seen over the page. */
export function over(top: string, alpha: number, under: string): string {
  return `#${[1, 3, 5].map(at => {
    const value = Math.round(alpha * parseInt(top.slice(at, at + 2), 16) + (1 - alpha) * parseInt(under.slice(at, at + 2), 16));
    return value.toString(16).padStart(2, '0');
  }).join('')}`;
}
