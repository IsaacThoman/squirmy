import { describe, expect, it } from 'vitest';
import { tabIn } from './tabs';

const tabs = (index: number) => ({ name: '(tabs)', state: { index, routes: [{ name: '(home)' }, { name: '(library)' }, { name: '(search)' }] } });

describe('tabIn', () => {
  it('finds the tabs under expo-router’s own root route', () => {
    const state = { index: 0, routes: [{ name: '__root', state: { index: 1, routes: [tabs(1), { name: 'name-playlist' }] } }] };
    expect(tabIn(state)).toBe('library');
  });

  it('finds them at the top too', () => {
    expect(tabIn({ routes: [tabs(2)] })).toBe('search');
  });

  it('is Home without tabs', () => {
    expect(tabIn(undefined)).toBe('home');
    expect(tabIn({ routes: [{ name: 'connect' }] })).toBe('home');
  });
});
