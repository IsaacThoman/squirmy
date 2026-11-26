import type { Artwork as ArtworkInfo, TrackSummary } from '@squirmy/contracts';
import { memo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useCanPlay } from '../../downloads/DownloadsProvider';
import { useCurrentTrackState } from '../../playback';
import { Icon } from '../../ui';
import { Artwork } from '../Artwork';
import { Focusable } from '../Focusable';
import { Menu, type MenuAction } from '../Menu';
import { useTrackMenu } from '../menus';
import { colors, type } from '../theme';

type Props = {
  artwork: ArtworkInfo | null | undefined;
  /** Artists are round. */
  circle?: boolean;
  /** For something without artwork: its icon and the color behind it. */
  icon?: string;
  color?: string;
  title: string;
  subtitle?: string;
  explicit?: boolean;
  /** Music that does not play: faded, still selectable. */
  dim?: boolean;
  /** Shown in the accent color: the song playing. */
  current?: boolean;
  width: number;
  /**
   * A shorter card whose cover fills its left end, as an artist's top songs are drawn; the
   * full one has its cover inset, as search results are.
   */
  compact?: boolean;
  onPress: () => void;
  menu?: { actions: MenuAction[]; onAction: (id: string) => void };
};

/** The height of a full card and of a compact one. */
const cardHeight = 160;
export const compactCardHeight = 112;

/**
 * A result as the system's music app draws it in Search and among an artist's top songs: a
 * frosted card with the cover at its left and the title and what it is beside it. Focus lifts
 * the whole card and lightens it; holding the click opens its menu.
 */
export const ResultCard = memo(function ResultCard({
  artwork, circle, icon, color, title, subtitle, explicit, dim, current, width, compact, onPress, menu,
}: Props) {
  const height = compact ? compactCardHeight : cardHeight;
  const cover = compact ? height : 120;
  const card = <Focusable
    accessibilityLabel={[title, subtitle, dim ? 'Not available' : null].filter(Boolean).join(', ')}
    onPress={onPress}
    scale={1.045}
    style={{ width }}
    liftStyle={styles.lift}
  >
    {({ focused }) => <View style={[styles.card, { height }, !compact && styles.inset, focused && styles.focused]}>
      <Artwork artwork={artwork} size={cover} circle={circle} radius={compact ? 0 : 10} focusEffect={false} icon={icon} color={color} dim={dim} />
      <View style={styles.words}>
        <View style={styles.titleLine}>
          {current && <Icon name="speaker.fill" size={22} color={focused ? colors.text : colors.accent} />}
          <Text numberOfLines={compact ? 1 : 2} style={[styles.title, dim && !focused && styles.dimText, current && !focused && styles.current]}>{title}</Text>
          {explicit && <Text style={styles.explicit}>E</Text>}
        </View>
        {subtitle ? <Text numberOfLines={1} style={[styles.subtitle, focused && styles.subtitleFocused]}>{subtitle}</Text> : null}
      </View>
    </View>}
  </Focusable>;
  return menu ? <Menu actions={menu.actions} onAction={menu.onAction} title={title}>{card}</Menu> : card;
});

/**
 * A song as a card. Choosing it runs `onPress` (play it, or for a song that does not play, open
 * its album); holding the click opens the song's menu.
 */
export const SongCard = memo(function SongCard({ track, subtitle, width, compact, onPress }: {
  track: TrackSummary; subtitle?: string; width: number; compact?: boolean; onPress: () => void;
}) {
  const playable = useCanPlay(track);
  const current = useCurrentTrackState(track.id);
  const menu = useTrackMenu(track);
  return <ResultCard artwork={track.album?.artwork} title={track.title} subtitle={subtitle ?? `Song · ${track.artistCredit}`}
    explicit={track.explicit ?? false} dim={!playable} current={current !== null} width={width} compact={compact} onPress={onPress} menu={menu} />;
});

const styles = StyleSheet.create({
  lift: { borderRadius: 18 },
  card: { flexDirection: 'row', alignItems: 'center', gap: 20, borderRadius: 18, overflow: 'hidden', backgroundColor: colors.platter },
  inset: { paddingHorizontal: 20 },
  focused: { backgroundColor: 'rgba(255,255,255,0.26)' },
  words: { flex: 1, gap: 2, paddingRight: 20 },
  titleLine: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  title: { ...type.body, fontWeight: '500', flexShrink: 1 },
  dimText: { color: colors.tertiary },
  current: { color: colors.accent },
  subtitle: { ...type.body, color: colors.secondary },
  subtitleFocused: { color: 'rgba(255,255,255,0.78)' },
  explicit: { fontSize: 17, fontWeight: '800', color: colors.background, backgroundColor: colors.secondary, borderRadius: 4, paddingHorizontal: 5, overflow: 'hidden' },
});
