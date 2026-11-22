import { describe, expect, it } from 'vitest';
import { albumLibraryButton } from './albumLibrary';

describe('albumLibraryButton', () => {
  it('adds an album that is not in the library and removes one the user added', () => {
    expect(albumLibraryButton({ title: 'A', library: null }, undefined, false)).toMatchObject({ icon: 'plus', action: 'add', label: 'Add A to library' });
    expect(albumLibraryButton({ title: 'A', library: 'saved' }, undefined, false)).toMatchObject({ icon: 'checkmark', action: 'remove', selected: true });
  });

  it('follows what the user just did before the server answers', () => {
    expect(albumLibraryButton({ title: 'A', library: null }, true, false)?.action).toBe('remove');
    expect(albumLibraryButton({ title: 'A', library: 'saved' }, false, false)?.action).toBe('add');
  });

  it('shows a collection album as on this server, with nothing to remove', () => {
    expect(albumLibraryButton({ title: 'A', library: 'collection' }, false, false)).toEqual({
      icon: 'checkmark', label: 'On this server', selected: true, action: 'none',
    });
  });

  it('offers nothing for an older server or offline', () => {
    expect(albumLibraryButton({ title: 'A' }, undefined, false)).toBeNull();
    expect(albumLibraryButton({ title: 'A', library: null }, undefined, true)).toBeNull();
  });
});
