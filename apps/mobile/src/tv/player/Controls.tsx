import type { TrackSummary } from '@squirmy/contracts';
import { useRouter, type Href } from 'expo-router';
import { memo } from 'react';
import { StyleSheet, View } from 'react-native';
import type { PlaybackActions } from '../../playback';
import type { HeartButton } from '../../library/heart';
import { SystemButton } from '../Button';
import { useTrackMenu } from '../menus';
import { colors, tv } from '../theme';
import type { Panel } from './model';

/** A mode that is on shows in the accent; filled would read as focused. */
const on = (active: boolean) => active ? colors.accent : undefined;

type ModesProps = {
  track: TrackSummary | undefined;
  shuffle: boolean;
  repeat: 'off' | 'all' | 'one';
  autoplay: boolean;
  /** The lyrics leave only the song's own buttons, as the system's music app does. */
  songOnly: boolean;
  heart: HeartButton;
  onHeart: () => void;
  actions: PlaybackActions;
  awake: () => boolean;
};

/**
 * The row above the scrubber, at the right as in the system's music app: Shuffle, Repeat and
 * Autoplay (in the accent while on), then the song’s heart and its menu.
 */
export const Modes = memo(function Modes({ track, shuffle, repeat, autoplay, songOnly, heart, onHeart, actions, awake }: ModesProps) {
  const menu = useTrackMenu(track);
  const guard = (run: () => void) => () => { if (awake()) run(); };
  return <View style={styles.modes}>
    {!songOnly && <>
      <SystemButton icon="shuffle" accessibilityLabel={shuffle ? 'Shuffle, on' : 'Shuffle, off'} tint={on(shuffle)}
        onPress={guard(actions.toggleShuffle)} />
      <SystemButton icon={repeat === 'one' ? 'repeat.1' : 'repeat'} tint={on(repeat !== 'off')}
        accessibilityLabel={repeat === 'off' ? 'Repeat, off' : repeat === 'all' ? 'Repeat, all' : 'Repeat, one song'}
        onPress={guard(actions.cycleRepeat)} />
      <SystemButton icon="infinity" accessibilityLabel={autoplay ? 'Autoplay, on' : 'Autoplay, off'} tint={on(autoplay)}
        onPress={guard(actions.toggleAutoplay)} />
    </>}
    <SystemButton icon={heart.icon} accessibilityLabel={heart.label} disabled={!track}
      tint={heart.failed ? colors.danger : heart.selected ? colors.accent : undefined} onPress={guard(onHeart)} />
    <SystemButton icon="ellipsis" accessibilityLabel={track ? `More options for ${track.title}` : 'More options'} disabled={!track || !menu.actions.length}
      menu={menu} />
  </View>;
});

type PanelsProps = {
  panel: Panel;
  onPanel: (panel: Exclude<Panel, 'none'>) => void;
  /** The device playing, for the Devices button's symbol; filled while it is not this Apple TV. */
  outputIcon: string;
  elsewhere: boolean;
  awake: () => boolean;
};

/** The bottom row: where the music plays, then the Lyrics and Up Next panels, filled while open. */
export const Panels = memo(function Panels({ panel, onPanel, outputIcon, elsewhere, awake }: PanelsProps) {
  const router = useRouter();
  return <View style={styles.panels}>
    <SystemButton icon={elsewhere ? outputIcon : 'airplay.audio'} accessibilityLabel="Playback device" prominent={elsewhere}
      onPress={() => { if (awake()) router.push('/devices' as Href); }} />
    <View style={styles.gap} />
    <SystemButton icon="quote.bubble" accessibilityLabel={panel === 'lyrics' ? 'Hide lyrics' : 'Lyrics'} prominent={panel === 'lyrics'}
      onPress={() => { if (awake()) onPanel('lyrics'); }} />
    <SystemButton icon="list.bullet" accessibilityLabel={panel === 'queue' ? 'Hide queue' : 'Up next'} prominent={panel === 'queue'}
      onPress={() => { if (awake()) onPanel('queue'); }} />
  </View>;
});

const styles = StyleSheet.create({
  modes: { flexDirection: 'row', justifyContent: 'flex-end', alignItems: 'center', gap: 28, paddingHorizontal: tv.gutter, height: 70 },
  panels: { flexDirection: 'row', justifyContent: 'flex-end', alignItems: 'center', gap: 28, paddingHorizontal: tv.gutter, height: 70 },
  gap: { width: 12 },
});
