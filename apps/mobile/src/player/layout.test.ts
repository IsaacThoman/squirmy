import { describe, expect, it } from 'vitest';
import { metadataHeight, rhythm, tabletArtworkSize, tabletPaneWidth } from './layout';

describe('metadataHeight', () => {
  it('leaves room for a two-line title and a two-line credit at the default text size', () => {
    expect(metadataHeight(1)).toBe(115);
  });

  it('grows with larger text', () => {
    expect(metadataHeight(1.2)).toBeGreaterThan(115);
  });

  it('stops growing once both lines reach their caps', () => {
    expect(metadataHeight(3.1)).toBe(metadataHeight(1.6));
    expect(metadataHeight(1.6)).toBe(Math.ceil(2 * 36 * 1.3 + 3 + 2 * 20 * 1.6));
  });
});

describe('rhythm', () => {
  it('spaces a 6.1-inch iPhone as Apple Music does', () => {
    expect(rhythm(852)).toEqual({ artworkGap: 16, buttonsTop: 22, buttonsBottom: 32, footerTop: 12 });
  });

  it('keeps that spacing on taller screens, where the artwork grows instead', () => {
    expect(rhythm(932)).toEqual(rhythm(852));
  });

  it('tightens in step with the height on shorter screens, down to an iPhone SE', () => {
    const mini = rhythm(812);
    const se = rhythm(667);
    expect(se).toEqual({ artworkGap: 8, buttonsTop: 8, buttonsBottom: 8, footerTop: 4 });
    expect(rhythm(568)).toEqual(se);
    for (const key of Object.keys(se) as (keyof typeof se)[]) {
      expect(mini[key]).toBeGreaterThan(se[key]);
      expect(mini[key]).toBeLessThanOrEqual(rhythm(852)[key]);
    }
  });
});

describe('tablet Now Playing', () => {
  it.each([[744, 1133], [834, 1194], [1024, 768], [1366, 1024]])('fits the pane and playback controls at %i × %i', (width, height) => {
    const pane = tabletPaneWidth(width, height, 1);
    expect(pane).toBeGreaterThanOrEqual(320);
    expect(pane).toBeLessThanOrEqual(680);
    expect(width - pane).toBeGreaterThanOrEqual(400);
  });

  it('uses the compact layout in narrow, short and larger-text windows that cannot fit both columns', () => {
    expect(tabletPaneWidth(600, 820, 1)).toBe(0);
    expect(tabletPaneWidth(1024, 420, 1)).toBe(0);
    expect(tabletPaneWidth(744, 1133, 2)).toBe(0);
    expect(tabletPaneWidth(834, 1194, 2)).toBeGreaterThanOrEqual(390);
  });

  it('leaves room for metadata and fits larger artwork to either column', () => {
    expect(tabletArtworkSize(1024, 530, 60)).toBe(470);
    expect(tabletArtworkSize(410, 530, 60)).toBe(362);
    expect(tabletArtworkSize(1366, 820, 60)).toBe(760);
    expect(tabletArtworkSize(1032, 1200, 60)).toBe(984);
    expect(tabletArtworkSize(1400, 1300, 60)).toBe(1000);
    expect(tabletArtworkSize(400, 120, 140)).toBe(1);
  });
});
