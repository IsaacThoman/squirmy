import { describe, expect, it } from 'vitest';
import {
  activeLine, blurReach, chromeDeadline, initialChrome, lineDelay, lineInView, lineLook, lyricCredits, lyricLines, lyricsChrome, lyricTiming,
  scrollRun, scrollTurn, springRemaining, waveDuration, type ChromeEvent, type ChromeRules, type LyricsChrome,
} from './lyrics';

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

describe('lyricCredits', () => {
  it('reads the author or lyricist tag', () => {
    expect(lyricCredits({ synced: '[ti:Song]\n[au: Ana Lee, Bo Diaz ]\n[00:01.00]Hi' })).toBe('Ana Lee, Bo Diaz');
    expect(lyricCredits({ synced: '[lr:Cy Park]\n[00:01.00]Hi' })).toBe('Cy Park');
  });

  it('is null when no one is named', () => {
    expect(lyricCredits({ synced: '[ar:Artist]\n[au:]\n[00:01.00]Hi' })).toBeNull();
    expect(lyricCredits({ synced: null })).toBeNull();
    expect(lyricCredits(null)).toBeNull();
  });
});

describe('lineLook', () => {
  const follow = { browsing: false, blur: true };

  it('draws the sung line bright and sharp', () => {
    expect(lineLook(0, follow)).toEqual({ opacity: 1, blur: 0 });
  });

  it('dims the others and blurs them more the farther they are, either way', () => {
    const blurs = [1, 2, 3, 4].map(distance => lineLook(distance, follow).blur);
    expect(blurs).toEqual([...blurs].sort((a, b) => a - b));
    expect(new Set(blurs).size).toBe(blurs.length);
    expect(lineLook(-2, follow)).toEqual(lineLook(2, follow));
    expect(lineLook(1, follow).opacity).toBeLessThan(0.5);
    expect(lineLook(1, follow).blur).toBeGreaterThan(0);
  });

  it('caps the blur and only dims lines past its reach', () => {
    expect(lineLook(blurReach, follow).blur).toBe(lineLook(blurReach - 1, follow).blur);
    expect(lineLook(blurReach + 1, follow)).toEqual({ opacity: lineLook(1, follow).opacity, blur: 0 });
  });

  it('clears the blur while browsing, keeping the sung line brightest', () => {
    const browsing = { browsing: true, blur: true };
    expect(lineLook(3, browsing).blur).toBe(0);
    expect(lineLook(3, browsing).opacity).toBeGreaterThan(lineLook(3, follow).opacity);
    expect(lineLook(3, browsing).opacity).toBeLessThan(lineLook(0, browsing).opacity);
  });

  it('only dims without blur (Reduce Transparency, Reduce Motion, VoiceOver)', () => {
    expect(lineLook(2, { browsing: false, blur: false })).toEqual({ opacity: lineLook(2, follow).opacity, blur: 0 });
  });

  it('draws plain lyrics, with no sung line, all bright', () => {
    expect(lineLook(null, follow)).toEqual({ opacity: 1, blur: 0 });
  });
});

describe('lyricsChrome', () => {
  const playing: ChromeRules = { canHide: true, synced: true };
  const run = (events: [ChromeEvent['type'], number][], rules = playing, from: LyricsChrome = initialChrome) =>
    events.reduce((state, [type, now]) => lyricsChrome(state, { type } as ChromeEvent, now, rules), from);

  it('hides the transport a few seconds after the page opens', () => {
    const opened = run([['show', 0]]);
    expect(opened).toMatchObject({ controls: true, hideAt: lyricTiming.hideControls });
    expect(chromeDeadline(opened)).toBe(lyricTiming.hideControls);
    expect(lyricsChrome(opened, { type: 'tick' }, lyricTiming.hideControls - 1, playing).controls).toBe(true);
    expect(lyricsChrome(opened, { type: 'tick' }, lyricTiming.hideControls, playing)).toMatchObject({ controls: false, hideAt: null });
  });

  it('brings the transport back on a tap, and hides it again later', () => {
    const tapped = run([['show', 0], ['tick', 5000], ['tap', 9000]]);
    expect(tapped).toMatchObject({ controls: true, hideAt: 9000 + lyricTiming.hideControls });
  });

  it('keeps the transport up while it is touched', () => {
    const touched = run([['show', 0], ['touchControls', 3000]]);
    expect(touched.hideAt).toBe(3000 + lyricTiming.hideControls);
  });

  it('never hides the transport when it may not (paused, VoiceOver, plain lyrics)', () => {
    const still: ChromeRules = { canHide: false, synced: true };
    const state = run([['show', 0], ['tap', 1000], ['scroll', 2000], ['rest', 2500]], still);
    expect(state.controls).toBe(true);
    expect(state.hideAt).toBeNull();
  });

  it('shows the transport when the rules stop it hiding, and starts the timer when they allow it again', () => {
    const hidden = run([['show', 0], ['tick', 5000]]);
    const paused = lyricsChrome(hidden, { type: 'rules' }, 6000, { canHide: false, synced: true });
    expect(paused).toMatchObject({ controls: true, hideAt: null });
    expect(lyricsChrome(paused, { type: 'rules' }, 8000, playing).hideAt).toBe(8000 + lyricTiming.hideControls);
  });

  it('hides the transport and stops following while a reader scrolls', () => {
    const scrolling = run([['show', 0], ['scroll', 1000]]);
    expect(scrolling).toMatchObject({ controls: false, following: false, hideAt: null, resumeAt: null });
  });

  it('goes back to the sung line a few seconds after the scroll rests', () => {
    const rested = run([['show', 0], ['scroll', 1000], ['rest', 2000]]);
    expect(rested.resumeAt).toBe(2000 + lyricTiming.resumeFollow);
    expect(chromeDeadline(rested)).toBe(2000 + lyricTiming.resumeFollow);
    expect(lyricsChrome(rested, { type: 'tick' }, 2000 + lyricTiming.resumeFollow - 1, playing).following).toBe(false);
    const back = lyricsChrome(rested, { type: 'tick' }, 2000 + lyricTiming.resumeFollow, playing);
    expect(back).toMatchObject({ following: true, resumeAt: null, controls: false });
  });

  it('waits again when the reader scrolls before it goes back', () => {
    const again = run([['show', 0], ['scroll', 1000], ['rest', 2000], ['scroll', 4000]]);
    expect(again).toMatchObject({ following: false, resumeAt: null });
    expect(run([['rest', 6000]], playing, again).resumeAt).toBe(6000 + lyricTiming.resumeFollow);
  });

  it('brings the transport back when the reader scrolls back up, and hides it again after the scroll rests', () => {
    const back = run([['show', 0], ['tick', 5000], ['grab', 6000], ['scrollBack', 6100]]);
    expect(back).toMatchObject({ controls: true, following: false, hideAt: null, resumeAt: null });
    const rested = run([['rest', 7000]], playing, back);
    expect(rested).toMatchObject({ controls: true, hideAt: 7000 + lyricTiming.hideControls, resumeAt: 7000 + lyricTiming.resumeFollow });
    expect(run([['tick', 7000 + lyricTiming.hideControls]], playing, rested)).toMatchObject({ controls: false, following: true });
  });

  it('hides the transport again when the reader turns back down', () => {
    expect(run([['show', 0], ['grab', 1000], ['scrollBack', 1100], ['scroll', 1500]])).toMatchObject({ controls: false, hideAt: null });
  });

  it('leaves the transport as it is when a finger lands without scrolling, and times it out from the rest', () => {
    const grabbed = run([['show', 0], ['grab', 1000]]);
    expect(grabbed).toMatchObject({ controls: true, following: false, hideAt: null });
    expect(run([['rest', 1200]], playing, grabbed).hideAt).toBe(1200 + lyricTiming.hideControls);
    expect(run([['show', 0], ['tick', 5000], ['grab', 6000], ['rest', 6200]])).toMatchObject({ controls: false, hideAt: null });
  });

  it('keeps the transport up when scrolling back while it may not hide', () => {
    expect(run([['show', 0], ['grab', 1000], ['scrollBack', 1100], ['rest', 2000]], { canHide: false, synced: true }))
      .toMatchObject({ controls: true, hideAt: null });
  });

  it('goes back at once on a tap', () => {
    expect(run([['show', 0], ['scroll', 1000], ['rest', 2000], ['tap', 2500]])).toMatchObject({ following: true, resumeAt: null, controls: true });
  });

  it('never stops following plain lyrics, which have no sung line', () => {
    expect(run([['show', 0], ['scroll', 1000], ['rest', 2000]], { canHide: false, synced: false })).toMatchObject({ following: true, resumeAt: null });
  });

  it('starts over when the page is shown again', () => {
    expect(run([['show', 0], ['scroll', 1000], ['show', 9000]])).toMatchObject({ controls: true, following: true, resumeAt: null });
  });

  it('tells which way a reader scrolls without following a wobble', () => {
    const steps = (list: number[]) => list.reduce(scrollRun, 0);
    expect(steps([4, 5, 6])).toBe(15);
    expect(steps([20, -3, -4])).toBe(-7);
    expect(Math.abs(steps([20, -3, -4]))).toBeLessThan(scrollTurn);
    expect(steps([20, -3, -4, -6])).toBeLessThanOrEqual(-scrollTurn);
  });

  it('has no deadline when nothing changes by itself', () => {
    expect(chromeDeadline(initialChrome)).toBeNull();
  });
});

describe('line motion', () => {
  it('springs from the whole way to rest', () => {
    expect(springRemaining(-50)).toBe(1);
    expect(springRemaining(0)).toBe(1);
    expect(springRemaining(150)).toBeLessThan(1);
    expect(springRemaining(150)).toBeGreaterThan(0);
    expect(Math.abs(springRemaining(waveDuration - lineDelay(99, 0)))).toBeLessThan(0.01);
  });

  it('overshoots only a little', () => {
    const samples = Array.from({ length: 100 }, (_, index) => springRemaining(index * 10));
    expect(Math.min(...samples)).toBeGreaterThan(-0.03);
    expect(Math.min(...samples)).toBeLessThan(0);
  });

  it('starts each line a moment after the one above', () => {
    expect(lineDelay(3, 5)).toBe(0);
    expect(lineDelay(5, 5)).toBe(0);
    expect(lineDelay(6, 5)).toBe(lyricTiming.stagger);
    expect(lineDelay(8, 5)).toBe(3 * lyricTiming.stagger);
    expect(lineDelay(500, 5)).toBe(lineDelay(17, 5));
  });
});
