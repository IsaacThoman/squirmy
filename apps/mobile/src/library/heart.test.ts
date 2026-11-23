import { describe, expect, it } from 'vitest';
import { heartButton, heartColor, heartFailure } from './heart';

const colors = { danger: 'red', accent: 'purple' };

describe('heartButton', () => {
  it('saves to the library when off and removes when on', () => {
    expect(heartButton(false, 'A')).toEqual({ icon: 'heart', label: 'Save A to library', selected: false, failed: false });
    expect(heartButton(true, 'A')).toEqual({ icon: 'heart.fill', label: 'Remove A from library', selected: true, failed: false });
  });

  it('shows a refused change on the heart, worded by what was refused', () => {
    // A refused save was set back, so the heart is off, and a tap saves again.
    expect(heartButton(false, 'Kid A', true)).toEqual({
      icon: 'exclamationmark.circle', label: 'Couldn’t save “Kid A” to your library. Try again.', selected: false, failed: true,
    });
    expect(heartButton(true, 'Kid A', false)).toEqual({
      icon: 'exclamationmark.circle', label: 'Couldn’t remove “Kid A” from your library. Try again.', selected: true, failed: true,
    });
  });

  it('colors a failure as an error, over the accent', () => {
    expect(heartColor(heartButton(true, 'A', false), colors, 'gray')).toBe('red');
    expect(heartColor(heartButton(true, 'A'), colors, 'gray')).toBe('purple');
    expect(heartColor(heartButton(false, 'A'), colors, 'gray')).toBe('gray');
  });
});

describe('heartFailure', () => {
  it('names the item when it can', () => {
    expect(heartFailure(true)).toBe('Couldn’t save that to your library. Try again.');
    expect(heartFailure(false, 'Roygbiv')).toBe('Couldn’t remove “Roygbiv” from your library. Try again.');
  });
});
