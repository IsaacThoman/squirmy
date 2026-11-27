import { describe, expect, it } from 'vitest';
import { releasesId, songsId, splitId } from './pageIds';

describe('page ids', () => {
  it('splits at the first tilde, as the phone does', () => {
    expect(splitId(releasesId('a1', 'ep-single'))).toEqual(['a1', 'ep-single']);
    expect(splitId(songsId('home', 'recently~played'))).toEqual(['home', 'recently~played']);
    expect(splitId('plain')).toEqual(['plain', '']);
  });
});
