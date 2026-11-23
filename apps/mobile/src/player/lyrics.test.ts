import { describe, expect, it } from 'vitest';
import { activeLine, lineInView, lyricLines } from './lyrics';

describe('lyricLines', () => {
  it('reads timed lines in order, with repeated stamps and tags', () => {
    const { lines, synced } = lyricLines({ plain: null, synced: '[ar:Someone]\n[00:12.50]First\n[00:05.00][00:30.25]Chorus\n[00:20.00]\n[01:02.123]Last' });
    expect(synced).toBe(true);
    expect(lines).toEqual([
      { text: 'Chorus', startMs: 5000 },
      { text: 'First', startMs: 12_500 },
      { text: 'Chorus', startMs: 30_250 },
      { text: 'Last', startMs: 62_123 },
    ]);
  });

  it('applies the offset tag', () => {
    expect(lyricLines({ plain: null, synced: '[offset:+500]\n[00:10.00]Line' }).lines[0]!.startMs).toBe(9500);
  });

  it('falls back to plain text', () => {
    expect(lyricLines({ synced: null, plain: 'One\n\n  Two \n' })).toEqual({
      synced: false, lines: [{ text: 'One', startMs: null }, { text: 'Two', startMs: null }],
    });
    expect(lyricLines(null)).toEqual({ synced: false, lines: [] });
  });
});

describe('activeLine', () => {
  const { lines } = lyricLines({ plain: null, synced: '[00:05.00]A\n[00:10.00]B\n[00:15.00]C' });
  it('follows the position', () => {
    expect(activeLine(lines, 0)).toBe(-1);
    expect(activeLine(lines, 5000)).toBe(0);
    expect(activeLine(lines, 14_999)).toBe(1);
    expect(activeLine(lines, 99_000)).toBe(2);
  });

  it('never highlights plain lyrics', () => {
    expect(activeLine([{ text: 'A', startMs: null }], 10_000)).toBe(-1);
  });
});

describe('lineInView', () => {
  it('is true while the line is on screen', () => {
    expect(lineInView(450, 300, 400)).toBe(true);
    expect(lineInView(300, 300, 400)).toBe(true);
  });

  it('is false for a line scrolled away, or not laid out yet', () => {
    expect(lineInView(250, 300, 400)).toBe(false);
    expect(lineInView(750, 300, 400)).toBe(false);
    expect(lineInView(undefined, 300, 400)).toBe(false);
    expect(lineInView(10, 0, 0)).toBe(false);
  });
});
