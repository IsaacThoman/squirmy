import { describe, expect, it } from 'vitest';
import { scanRoots, scanTotal } from './scanProgress';

const event = (rootId: string, phase: 'discovering' | 'probing' | 'matching' | 'idle', processed: number, total: number) =>
  ({ type: 'scan.progress', rootId, phase, processed, total }) as const;

describe('scan progress', () => {
  it('adds up the folders being scanned', () => {
    let roots = scanRoots({}, event('a', 'probing', 10, 100));
    roots = scanRoots(roots, event('b', 'probing', 5, 50));
    roots = scanRoots(roots, event('a', 'probing', 40, 100));
    expect(scanTotal(roots)).toEqual({ processed: 45, total: 150 });
  });

  it('drops a folder once it is idle, and is null with none left', () => {
    const roots = scanRoots(scanRoots({}, event('a', 'probing', 10, 100)), event('a', 'idle', 100, 100));
    expect(roots).toEqual({});
    expect(scanTotal(roots)).toBeNull();
  });

  it('is null before any file is counted', () => {
    expect(scanTotal(scanRoots({}, event('a', 'discovering', 0, 0)))).toBeNull();
  });
});
