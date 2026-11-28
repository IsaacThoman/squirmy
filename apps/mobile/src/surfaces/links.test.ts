import { describe, expect, it } from 'vitest';
import { systemPath, widgetLink } from './links';

describe('links from the widgets', () => {
  it('opens a Jump back in tile’s page', () => {
    expect(widgetLink('squirmy://album/0193c1d2-aaaa-7000-8000-000000000001')).toEqual({ kind: 'page', page: 'album', id: '0193c1d2-aaaa-7000-8000-000000000001' });
    expect(widgetLink('squirmy-dev://playlist/liked')).toEqual({ kind: 'page', page: 'playlist', id: 'liked' });
    expect(widgetLink('squirmy://songs/mix~m1')).toEqual({ kind: 'page', page: 'songs', id: 'mix~m1' });
  });

  it('opens Downloads from the Live Activity and Now Playing from its widget', () => {
    expect(widgetLink('squirmy://downloads')).toEqual({ kind: 'downloads' });
    expect(widgetLink('squirmy://now-playing')).toEqual({ kind: 'nowPlaying' });
  });

  it('keeps the router away from the widgets’ links, and leaves it every other link', () => {
    expect(systemPath('squirmy://album/a1')).toBeNull();
    expect(systemPath('squirmy://now-playing')).toBeNull();
    expect(systemPath('squirmy://settings')).toBe('squirmy://settings');
    expect(widgetLink('squirmy://album')).toBeNull();
    expect(widgetLink('squirmy://album/a1/extra')).toBeNull();
    expect(widgetLink('squirmy://album/%E0%A4%A')).toBeNull();
  });
});
