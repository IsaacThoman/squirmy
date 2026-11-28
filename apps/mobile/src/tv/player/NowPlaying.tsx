import { useIsFocused, useRouter, type Href } from 'expo-router';
import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Animated, StyleSheet, Text, View } from 'react-native';
import { useLoading, usePlaybackState } from '../../playback';
import { whereItPlays } from '../../player/session';
import { useCurrentTrackHeart } from '../../player/useCurrentTrackHeart';
import { usePlaybackStatus } from '../../player/usePlaybackStatus';
import { Icon } from '../../ui';
import { Button } from '../Button';
import { TabRoot } from '../Sidebar';
import { colors, tv, type } from '../theme';
import { Ambience } from './Ambience';
import { Carousel, coverSize, sideLeft, type Inks } from './Carousel';
import { Modes, Panels } from './Controls';
import { Lyrics } from './Lyrics';
import { canIdle, carouselSlots, containerTitle, inkFrom, statusLine, togglePanel, type Panel, type Slot } from './model';
import { Scrubber } from './Scrubber';
import { QualityBadge } from './TrackInfo';
import { UpNext } from './UpNext';
import { useChrome } from './useChrome';
import { useMenuKey } from './useMenuKey';

/**
 * Now Playing, a tab of its own as in the system's music app: the covers of the songs around the
 * one playing over a backdrop made from its colours, the transport under them, and the lyrics or
 * the queue beside the cover on request. Left alone while music plays, the controls fade and
 * leave the covers. When another device plays, this is its remote: the same screen, saying where.
 */
export function NowPlayingScreen() {
  const { current } = usePlaybackState();
  // The sidebar opens over it as over any tab; it has no pill, as the system's has none here.
  return <TabRoot pill={false}>{current ? <Playing /> : <NothingPlaying />}</TabRoot>;
}

function Playing() {
  const focused = useIsFocused();
  const { session, queue, track, actions, output, remote, detached, signal } = usePlaybackState();
  const { heart, toggle: toggleHeart } = useCurrentTrackHeart();
  const [panel, setPanel] = useState<Panel>('none');
  const failed = session.current?.state === 'failed';
  const { chrome, controls, scrubber, settled, awake, hide } = useChrome(focused && canIdle({ playing: session.playing, panel, failed }));
  const { current, autoplay } = session;
  const { history, queue: upNext, autoplayQueue } = queue;
  const slots = useMemo(() => carouselSlots({ current, autoplay }, { history, queue: upNext, autoplayQueue }),
    [autoplay, autoplayQueue, current, history, upNext]);
  const color = track?.album?.artwork?.color;
  const inks = useMemo<Inks>(() => ({ title: inkFrom(color, 0.84) ?? colors.text, artist: inkFrom(color, 0.52) ?? colors.secondary }), [color]);

  // The cover moves aside for a panel; the panel fades in beside it.
  const aside = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.spring(aside, { toValue: panel === 'none' ? 0 : 1, speed: 12, bounciness: 0, useNativeDriver: true }).start();
  }, [aside, panel]);
  // Menu closes an open panel, then hides the controls; once they are hidden it is the system's again.
  useMenuKey(focused && (panel !== 'none' || chrome === 'shown'), () => {
    if (panel !== 'none') setPanel('none');
    else hide();
  });
  const onPanel = useCallback((pressed: Exclude<Panel, 'none'>) => setPanel(open => togglePanel(open, pressed)), []);

  const onSelect = useCallback(({ entry, offset }: Slot) => {
    if (offset === 0) actions.playPause();
    else if (offset < 0) actions.previousTrack();
    else actions.playQueueEntry(entry.id);
  }, [actions]);

  const elsewhere = remote && !output.isThisDevice;
  const where = whereItPlays(output, session.playing ? 'Playing' : 'Paused');
  const toSide = aside.interpolate({ inputRange: [0, 1], outputRange: [0, sideLeft - (1920 - coverSize) / 2] });
  return <View style={styles.screen}>
    <Ambience artwork={track?.album?.artwork} />
    <Animated.Text numberOfLines={1} style={[styles.container, {
      color: inks.title,
      // A panel takes the top of the screen; the line gives way to it, as in the system's lyrics.
      opacity: aside.interpolate({ inputRange: [0, 0.5], outputRange: [1, 0], extrapolate: 'clamp' }),
      transform: [{ translateY: settled.interpolate({ inputRange: [0, 1], outputRange: [0, 20] }) }],
    }]}>
      {containerTitle(session.context, track?.album?.title)}
    </Animated.Text>
    <Carousel slots={slots} aside={aside} settled={settled} inks={inks} panelOpen={panel !== 'none'} awake={awake} onSelect={onSelect} />
    <Animated.View style={[styles.status, { transform: [{ translateX: toSide }, { translateY: settled.interpolate({ inputRange: [0, 1], outputRange: [0, 40] }) }] }]}>
      <Status remote={elsewhere} where={where} detached={detached} />
      <QualityBadge signal={signal} />
    </Animated.View>
    {panel !== 'none' && <PanelView key={panel}>
      {panel === 'lyrics' ? <Lyrics track={track} live={focused} /> : <UpNext />}
    </PanelView>}
    <View style={styles.controls}>
      <Animated.View style={{ opacity: controls }}>
        <Modes track={track} shuffle={session.shuffle} repeat={session.repeat} autoplay={session.autoplay} songOnly={panel === 'lyrics'}
          heart={heart} onHeart={toggleHeart} actions={actions} awake={awake} />
      </Animated.View>
      <Animated.View style={[styles.scrubber, { opacity: scrubber }]}>
        <Scrubber awake={awake} disabled={failed} live={focused} hasTVPreferredFocus />
      </Animated.View>
      <Animated.View style={{ opacity: controls }}>
        <Panels panel={panel} onPanel={onPanel} outputIcon={output.icon} elsewhere={elsewhere || detached} awake={awake} />
      </Animated.View>
    </View>
  </View>;
}

/** The lyrics or the queue, fading in to the right of the cover. */
function PanelView({ children }: { children: ReactNode }) {
  const appear = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(appear, { toValue: 1, duration: 380, delay: 120, useNativeDriver: true }).start();
  }, [appear]);
  return <Animated.View style={[styles.panel, { opacity: appear, transform: [{ translateX: appear.interpolate({ inputRange: [0, 1], outputRange: [60, 0] }) }] }]}>
    {children}
  </Animated.View>;
}

/**
 * The line under the titles: what playback has to report, a song slow to load, or where the
 * music plays when it is not here. It reads the status store itself, so a notice redraws only it.
 */
const Status = memo(function Status({ remote, where, detached }: { remote: boolean; where: string; detached: boolean }) {
  const notice = usePlaybackStatus();
  const loading = useLoading();
  const line = statusLine({ notice, slow: loading === 'slow', remote, where, detached });
  if (!line) return null;
  return <View accessibilityLiveRegion="polite" style={styles.statusLine}>
    {line.tone === 'quiet' && remote && <Icon name="airplay.audio" size={26} color={colors.secondary} />}
    <Text numberOfLines={2} style={[styles.statusText, line.tone === 'notice' && styles.notice]}>
      {line.text}{line.detail ? <Text style={styles.statusDetail}>{`\n${line.detail}`}</Text> : null}
    </Text>
  </View>;
});

/** Nothing in the session: a calm page with the way back to music. */
function NothingPlaying() {
  const router = useRouter();
  return <View style={styles.screen}>
    <Ambience artwork={null} />
    <View style={styles.nothing}>
      <Icon name="music.note" size={110} color={colors.secondary} />
      <Text style={styles.nothingTitle}>Not Playing</Text>
      <Text style={styles.nothingDetail}>Choose an album, a playlist or a song, and it plays here.</Text>
      <Button label="Go to Home" icon="house.fill" hasTVPreferredFocus onPress={() => router.navigate('/(tabs)/(home)' as Href)} />
    </View>
  </View>;
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background, overflow: 'hidden' },
  container: { position: 'absolute', top: 72, left: 360, right: 360, textAlign: 'center', fontSize: 28, lineHeight: 35, fontWeight: '500' },
  status: { position: 'absolute', top: 808, left: (1920 - 640) / 2, width: 640, alignItems: 'center' },
  statusLine: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  statusText: { ...type.callout, fontSize: 27, color: colors.secondary, textAlign: 'center' },
  notice: { color: colors.accent, fontWeight: '600' },
  statusDetail: { color: colors.secondary, fontWeight: '500' },
  panel: { position: 'absolute', top: 40, bottom: 300, left: sideLeft + coverSize + 168, right: 180 },
  controls: { position: 'absolute', left: 0, right: 0, top: 803 },
  scrubber: { marginTop: 17, marginBottom: 16 },
  nothing: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 24, paddingHorizontal: tv.gutter },
  nothingTitle: { ...type.title1 },
  nothingDetail: { ...type.body, color: colors.secondary, textAlign: 'center', marginBottom: 20 },
});
