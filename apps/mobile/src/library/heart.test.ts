import { describe, expect, it } from 'vitest';
import { heartButton } from './heart';

describe('heartButton', () => {
  it('saves to the library when off and removes when on', () => {
    expect(heartButton(false, 'A')).toEqual({ icon: 'heart', label: 'Save A to library', selected: false });
    expect(heartButton(true, 'A')).toEqual({ icon: 'heart.fill', label: 'Remove A from library', selected: true });
  });
});
