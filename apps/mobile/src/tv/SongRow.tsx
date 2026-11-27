import type { TrackSummary } from '@squirmy/contracts';
import { memo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useCanPlay } from '../downloads/DownloadsProvider';
import { trackDuration } from '../library/duration';
import { useCurrentTrackState, usePlaybackActions, useTrackLoading } from '../playback';
import type { TrackActionOptions } from '../library/trackActions';
import { Icon } from '../ui';
import { Artwork } from './Artwork';
import { Focusable } from './Focusable';
import { Menu } from './Menu';
import { useOpenPage, useTrackMenu } from './menus';
import { colors, type } from './theme';

type Props = {
  track: TrackSummary;
  /** The position on its album; a row without one shows the cover instead. */
  number?: number | null;
  /** Shown under the title, such as the artist where it differs from the album's. */
  subtitle?: string;
  /** Show the cover, for a list of songs from many albums. */
  cover?: boolean;
  /** Say the album after the artist. */
  album?: boolean;
  onPress: () => void;
  menu?: TrackActionOptions;
  hasTVPreferredFocus?: boolean;
  onFocus?: () => void;
};

/**
 * A song in a list. Focus lays a frosted platter under it and its number becomes a play glyph,
 * as in the system's music app; holding the click opens the song's menu.
 */
export const SongRow = memo(function SongRow({ track, number, subtitle, cover, album, onPress, menu, hasTVPreferredFocus, onFocus }: Props) {
  const playable = useCanPlay(track);
  const current = useCurrentTrackState(track.id);
  const loading = useTrackLoading(track.id);
  const { actions, onAction } = useTrackMenu(track, menu);
  const { toggleIfCurrent } = usePlaybackActions();
  const openPage = useOpenPage();
  // As on the phone: the song playing (or paused) pauses or resumes rather than starting over,
  // and one that can't play opens its album, where the rest of it may.
  const press = () => {
    if (toggleIfCurrent(track.id)) return;
    if (playable) onPress();
    else if (track.album && track.album.id !== menu?.album) openPage('album', track.album.id);
  };
  const credit = subtitle ?? (album && track.album ? `${track.artistCredit} · ${track.album.title}` : undefined);
  return <Menu actions={actions} onAction={onAction} title={track.title}>
    <Focusable
      accessibilityLabel={[track.title, credit, playable ? null : 'Not available'].filter(Boolean).join(', ')}
      onPress={press}
      hasTVPreferredFocus={hasTVPreferredFocus}
      onFocusChange={focused => { if (focused) onFocus?.(); }}
      scale={1.025}
      liftStyle={({ focused }) => [styles.row, cover && styles.coverRow, focused && styles.focused]}
    >
      {({ focused }) => {
        const ink = focused ? colors.text : playable ? colors.text : colors.tertiary;
        const marker = current
          ? <Icon name={current === 'playing' && loading === 'none' ? 'waveform' : 'speaker.fill'} size={26} color={focused ? colors.text : colors.accent} />
          : focused && playable ? <Icon name="play.fill" size={24} color={colors.text} />
            : <Text style={[styles.number, !playable && styles.faded]}>{number ?? ''}</Text>;
        return <>
          {cover
            ? <View style={styles.cover}>
              <Artwork artwork={track.album?.artwork} size={72} radius={8} focusEffect={false} dim={!playable} />
              {(current || (focused && playable)) && <View style={styles.coverMarker}>{marker}</View>}
            </View>
            : <View style={styles.marker}>{marker}</View>}
          <View style={styles.words}>
            <View style={styles.titleLine}>
              <Text numberOfLines={1} style={[styles.title, { color: current && !focused ? colors.accent : ink }]}>{track.title}</Text>
              {track.explicit && <Text style={styles.explicit}>E</Text>}
            </View>
            {credit ? <Text numberOfLines={1} style={[styles.credit, !playable && styles.faded]}>{credit}</Text> : null}
          </View>
          <Text style={[styles.duration, focused && styles.durationFocused, !playable && styles.faded]}>
            {track.durationMs ? trackDuration(track.durationMs) : ''}
          </Text>
        </>;
      }}
    </Focusable>
  </Menu>;
});

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', minHeight: 95, paddingHorizontal: 30, borderRadius: 16, gap: 24 },
  coverRow: { minHeight: 104, paddingHorizontal: 16 },
  focused: { backgroundColor: 'rgba(255,255,255,0.24)' },
  marker: { width: 44, alignItems: 'center' },
  number: { ...type.body, color: colors.secondary, fontVariant: ['tabular-nums'] },
  cover: { width: 72, height: 72 },
  coverMarker: { ...StyleSheet.absoluteFill, borderRadius: 8, backgroundColor: 'rgba(0,0,0,0.45)', alignItems: 'center', justifyContent: 'center' },
  words: { flex: 1, gap: 2 },
  titleLine: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  title: { ...type.body, fontWeight: '500', flexShrink: 1 },
  credit: { ...type.caption, fontSize: 25 },
  explicit: { fontSize: 17, fontWeight: '800', color: colors.background, backgroundColor: colors.secondary, borderRadius: 4, paddingHorizontal: 5, overflow: 'hidden' },
  duration: { ...type.body, color: colors.secondary, fontVariant: ['tabular-nums'] },
  durationFocused: { color: colors.text },
  faded: { color: colors.tertiary },
});
