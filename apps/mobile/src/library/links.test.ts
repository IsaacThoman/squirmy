import { describe, expect, it, vi } from 'vitest';

vi.mock('expo-router', () => ({ useRootNavigationState: () => undefined }));
const { tabOf } = await import('./links');

const tabs = (index: number) => ({ index, routes: [{ name: '(home)' }, { name: '(library)' }, { name: '(search)' }] });

describe('tabOf', () => {
  it('reads the selected tab', () => {
    expect(tabOf({ routes: [{ name: '(tabs)', state: tabs(1) }] })).toBe('library');
    expect(tabOf({ routes: [{ name: '(tabs)', state: tabs(2) }, { name: 'track-actions' }], index: 1 })).toBe('search');
  });

  it('finds the tabs below the navigation container’s own root', () => {
    expect(tabOf({ routes: [{ name: '__root', state: { routes: [{ name: '(tabs)', state: tabs(1) }] } }] })).toBe('library');
  });

  it('falls back to Home before the tabs exist', () => {
    expect(tabOf(undefined)).toBe('home');
    expect(tabOf({ routes: [{ name: 'sign-in' }] })).toBe('home');
  });
});
