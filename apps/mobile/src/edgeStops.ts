/** How long a scroll edge is, past the status bar, as it fades out. */
export const scrollEdgeFade = 14;

/**
 * Alpha stops, evenly spaced from the top of an edge `solid + fade` tall: fully on over `solid`,
 * then easing out to nothing. Evenly spaced because SwiftUI's gradient takes colors only.
 */
export function edgeStops(solid: number, fade: number, count = 16): string[] {
  const height = solid + fade;
  return Array.from({ length: count }, (_, index) => {
    const at = height * index / (count - 1);
    const t = fade > 0 ? Math.min(Math.max((at - solid) / fade, 0), 1) : at > solid ? 1 : 0;
    const alpha = 1 - t * t * (3 - 2 * t);
    return `#FFFFFF${Math.round(alpha * 255).toString(16).padStart(2, '0').toUpperCase()}`;
  });
}
