/** Behind artwork that has no color of its own. */
export const fallbackTint = '#3F4854';

/**
 * A darker shade of an artwork's color, for surfaces that carry white text and the cover
 * itself: light covers stay legible, and the cover still stands out from its background.
 */
export function shade(color: string | null | undefined, amount = 0.55): string {
  const match = /^#([0-9a-f]{6})$/i.exec(color ?? '');
  if (!match) return fallbackTint;
  const value = parseInt(match[1]!, 16);
  const channel = (shift: number) => Math.round(((value >> shift) & 255) * amount).toString(16).padStart(2, '0');
  return `#${channel(16)}${channel(8)}${channel(0)}`;
}
