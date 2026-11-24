import { describe, expect, it } from 'vitest';
import { edgeStops } from './edgeStops';

const alpha = (stop: string) => parseInt(stop.slice(7), 16);

describe('edgeStops', () => {
  it('is fully on over the solid part and clear at the bottom', () => {
    const stops = edgeStops(54, 14);
    expect(stops).toHaveLength(16);
    expect(stops[0]).toBe('#FFFFFFFF');
    // 54 of 68 points: the first twelve of sixteen evenly spaced stops lie within it.
    expect(stops.slice(0, 12).every(stop => alpha(stop) === 255)).toBe(true);
    expect(stops.at(-1)).toBe('#FFFFFF00');
  });

  it('only fades out going down, with no step', () => {
    const alphas = edgeStops(0, 12).map(alpha);
    for (let index = 1; index < alphas.length; index++) {
      expect(alphas[index]!).toBeLessThanOrEqual(alphas[index - 1]!);
      expect(alphas[index - 1]! - alphas[index]!).toBeLessThan(40);
    }
  });
});
