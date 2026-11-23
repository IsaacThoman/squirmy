import { describe, expect, it } from 'vitest';
import { playlistAddFailure, playlistEditFailure, wantFailure, wantFailureLabel } from './failures';

describe('inline failures', () => {
  it('words a wantlist refusal by what was refused', () => {
    expect(wantFailure(true, 'Kid A')).toBe('Couldn’t add “Kid A” to your wantlist. Try again.');
    expect(wantFailure(false, 'Kid A')).toBe('Couldn’t remove “Kid A” from your wantlist. Try again.');
    expect(wantFailureLabel(true)).toBe('Couldn’t add. Try again');
    expect(wantFailureLabel(false)).toBe('Couldn’t remove. Try again');
  });

  it('says which playlist edit was refused', () => {
    expect(playlistEditFailure('remove')).toBe('Couldn’t remove the song. Try again.');
    expect(playlistEditFailure('move')).toBe('Couldn’t move the song. Try again.');
    expect(playlistEditFailure('delete')).toBe('Couldn’t delete the playlist. Try again.');
    expect(playlistAddFailure('Road trip')).toBe('Couldn’t add to “Road trip”. Try again.');
  });
});
