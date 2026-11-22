/**
 * How far React Native text may grow with the system text size. Display text (page titles,
 * Now Playing's title) stops early: it is already large, and at accessibility sizes it would
 * push into the layout around it. Secondary lines grow further. Body text is not capped.
 */
export const displayFontScale = 1.3;
export const secondaryFontScale = 1.6;

/**
 * The system's font scale is 1.353 at its largest standard size (xxxLarge) and 1.786 at the
 * first accessibility size, so anything past this is an accessibility size: rows that put a
 * label and its value side by side stack them from here on.
 */
const accessibilityFontScale = 1.5;

export function isAccessibilitySize(fontScale: number): boolean {
  return fontScale > accessibilityFontScale;
}
