import { describe, expect, it } from 'vitest';
import { Echoes } from './echoes';

describe('Echoes', () => {
  it('recognises the echo of a change made here once', () => {
    const echoes = new Echoes();
    echoes.expect(['track', 'a']);
    expect(echoes.isOwn([['likes'], ['home'], ['track', 'a']])).toBe(true);
    expect(echoes.isOwn([['likes'], ['home'], ['track', 'a']])).toBe(false);
  });

  it('counts two changes to the same item as two echoes', () => {
    const echoes = new Echoes();
    echoes.expect(['track', 'a']);
    echoes.expect(['track', 'a']);
    expect(echoes.isOwn([['track', 'a']])).toBe(true);
    expect(echoes.isOwn([['track', 'a']])).toBe(true);
    expect(echoes.isOwn([['track', 'a']])).toBe(false);
  });

  it('treats other keys, and echoes that come too late, as changes from elsewhere', () => {
    let now = 0;
    const echoes = new Echoes(1000, () => now);
    echoes.expect(['album', 'x']);
    expect(echoes.isOwn([['track', 'x'], ['likes']])).toBe(false);
    now = 1001;
    expect(echoes.isOwn([['album', 'x']])).toBe(false);
  });
});
