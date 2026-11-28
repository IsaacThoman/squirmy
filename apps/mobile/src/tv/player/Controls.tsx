import type { TrackSummary } from '@squirmy/contracts';
import { useRouter, type Href } from 'expo-router';
import { memo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useSleepTimer, type PlaybackActions } from '../../playback';
import type { HeartButton } from '../../library/heart';
import { SystemButton } from '../Button';
import { Icon } from '../../ui';
import { useTrackMenu } from '../menus';
import { chosenSleepTimer, sleepTimerSubmenu } from '../menuModel';
import { colors, tv, type } from '../theme';
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
 * Autoplay (in the accent while on), then the song’s heart and its menu, which ends with the
 * sleep timer. While a timer is set, a moon and the time left come first.
 */
export const Modes = memo(function Modes({ track, shuffle, repeat, autoplay, songOnly, heart, onHeart, actions, awake }: ModesProps) {
  const songMenu = useTrackMenu(track);
  const sleep = useSleepTimer();
  const menu = !sleep.canSet ? songMenu : {
    actions: [...songMenu.actions, sleepTimerSubmenu({ ...sleep, on: sleep.timer !== undefined })],
    onAction: (id: string) => {
      const timer = chosenSleepTimer(id, sleep.choices);
      if (timer === undefined) songMenu.onAction(id);
      else actions.setSleepTimer(timer);
    },
  };
  const guard = (run: () => void) => () => { if (awake()) run(); };
  return <View style={styles.modes}>
    {sleep.label && <View style={styles.sleep} accessible accessibilityLabel={sleep.spoken ?? undefined}>
      <Icon name="moon.zzz.fill" size={26} color={colors.secondary} />
      <Text style={styles.sleepText}>{sleep.label}</Text>
    </View>}
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
  sleep: { flexDirection: 'row', alignItems: 'center', gap: 10, marginRight: 8 },
  sleepText: { ...type.caption, fontVariant: ['tabular-nums'] },
  panels: { flexDirection: 'row', justifyContent: 'flex-end', alignItems: 'center', gap: 28, paddingHorizontal: tv.gutter, height: 70 },
  gap: { width: 12 },
});
