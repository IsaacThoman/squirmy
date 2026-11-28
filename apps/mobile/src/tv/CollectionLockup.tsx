import { useRouter } from 'expo-router';
import { memo } from 'react';
import { mosaicCovers } from '../library/mosaic';
import type { Collection } from '../library/shared';
import { Lockup } from './Lockup';
import { Menu } from './Menu';
import type { useCollectionMenu } from './menus';
import { tv } from './theme';

/** Liked Songs, history, and a playlist, mix or radio with no covers yet have a cover of their own. */
const specials = {
  liked: { color: '#6F5BB0', icon: 'heart.fill' },
  recent: { color: '#3A5752', icon: 'clock.arrow.circlepath' },
  playlist: { color: '#4F416B', icon: 'music.note.list' },
  mix: { color: '#3D3A56', icon: 'waveform' },
  radio: { color: '#563A3D', icon: 'dot.radiowaves.left.and.right' },
} as const;

type Props = {
  item: Collection;
  size?: number;
  menu: ReturnType<typeof useCollectionMenu>;
  hasTVPreferredFocus?: boolean;
};

/** An album, artist or playlist as a tile: it opens its page, and holding the click opens its menu. */
export const CollectionLockup = memo(function CollectionLockup({ item, size = tv.tile, menu, hasTVPreferredFocus }: Props) {
  const router = useRouter();
  const { actions, onAction } = menu(item);
  const artwork = item.artwork ?? mosaicCovers(item.artworks ?? [])[0] ?? null;
  const special = !artwork && item.special ? specials[item.special] : null;
  return <Menu actions={actions} onAction={onAction} title={item.title}>
    <Lockup
      artwork={artwork}
      title={item.title}
      subtitle={item.round ? undefined : item.subtitle}
      circle={item.round}
      size={size}
      dim={item.dim}
      icon={special?.icon}
      color={special?.color}
      hasTVPreferredFocus={hasTVPreferredFocus}
      onPress={() => router.push(item.href)}
    />
  </Menu>;
});
