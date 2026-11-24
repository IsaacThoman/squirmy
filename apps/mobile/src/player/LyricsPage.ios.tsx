import { memo, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type PropsWithChildren } from 'react';
import { AccessibilityInfo, StyleSheet, useWindowDimensions, View, type LayoutChangeEvent } from 'react-native';
import Animated, {
  Easing, ReduceMotion, scrollTo, useAnimatedReaction, useAnimatedRef, useAnimatedStyle, useScrollOffset, useSharedValue, withTiming,
  type SharedValue,
} from 'react-native-reanimated';
import { scheduleOnRN, scheduleOnUI } from 'react-native-worklets';
import { useLyrics } from '../data/queries';
import { usePlaybackState, usePosition } from '../playback';
import { LyricButton, LyricCredits } from './Controls';
import { selectionFeedback } from './design';
import {
  activeLine, chromeDeadline, initialChrome, lineDelay, lineLook, lyricCredits, lyricLines, lyricsChrome, scrollRun, scrollTurn, springRemaining, waveDuration,
  type ChromeEvent, type ChromeRules,
} from './lyrics';
import LyricsEmpty from './LyricsEmpty';
import type { LyricsProps } from './LyricsPage';
import { usePlayerShown } from './visibility';

/** How far a line change may visibly carry the lines, as a share of the page; a longer jump scrolls instead. */
const waveReach = 0.6;
/** Opening the page, the lines rise this far into place. */
const entrance = 90;

type AccessibilitySetting = 'reduceMotionChanged' | 'reduceTransparencyChanged' | 'screenReaderChanged';
const settingQuery = {
  reduceMotionChanged: () => AccessibilityInfo.isReduceMotionEnabled(),
  reduceTransparencyChanged: () => AccessibilityInfo.isReduceTransparencyEnabled(),
  screenReaderChanged: () => AccessibilityInfo.isScreenReaderEnabled(),
} satisfies Record<AccessibilitySetting, () => Promise<boolean>>;

/** An accessibility setting, kept current as it is turned on and off. */
function useAccessibilitySetting(setting: AccessibilitySetting): boolean {
  const [enabled, setEnabled] = useState(false);
  useEffect(() => {
    let live = true;
    void settingQuery[setting]().then(value => { if (live) setEnabled(value); });
    const subscription = AccessibilityInfo.addEventListener(setting, setEnabled);
    return () => { live = false; subscription.remove(); };
  }, [setting]);
  return enabled;
}

/** The lines' shared motion: each line rides `shift` back to its place on a spring `clock` ms in, a moment after the line above. */
type Wave = { shift: SharedValue<number>; clock: SharedValue<number>; from: SharedValue<number> };

/**
 * Lyrics as Apple Music draws them: big, bold lines with the sung one bright near the top
 * and the rest dim and blurred more the farther they are, rippling up as the song moves on.
 * Left untouched while it plays, the page hides the transport and takes the screen; a tap,
 * or scrolling back up, brings it back. Scrolling by hand clears the blur, and a few seconds after the scroll rests
 * the page goes back to the sung line. The rules are `lyricsChrome`'s.
 */
export default function LyricsPage({ selected, ref, onControlsHidden }: LyricsProps) {
  const shown = usePlayerShown();
  const visible = selected && shown;
  const { height: screenHeight, fontScale } = useWindowDimensions();
  const { track, session, actions } = usePlaybackState();
  const lyrics = useLyrics(track);
  const { lines, synced } = useMemo(() => lyricLines(lyrics.data), [lyrics.data]);
  const credits = useMemo(() => lyricCredits(lyrics.data), [lyrics.data]);
  const position = usePosition(visible && synced);
  const sung = synced ? activeLine(lines, position) : -1;
  const reduceMotion = useAccessibilitySetting('reduceMotionChanged');
  const reduceTransparency = useAccessibilitySetting('reduceTransparencyChanged');
  const screenReader = useAccessibilitySetting('screenReaderChanged');
  // Blur is motion and transparency both; VoiceOver's users may still read the screen, so it goes too.
  const blurs = !reduceMotion && !reduceTransparency && !screenReader;
  const timed = synced && lines.length > 0;

  // Plain lyrics have no sung line to keep up with, so the transport stays for them, and while
  // paused, and while VoiceOver runs: its users find the controls where they left them.
  const rules: ChromeRules = { canHide: visible && timed && session.playing && !screenReader, synced: timed };
  const rulesRef = useRef(rules);
  rulesRef.current = rules;
  const [chrome, setChrome] = useState(initialChrome);
  const dispatch = useCallback((event: ChromeEvent) => {
    const now = Date.now();
    setChrome(state => lyricsChrome(state, event, now, rulesRef.current));
  }, []);
  const following = chrome.following || !timed;
  const browsing = !following;

  useImperativeHandle(ref, () => ({ touchControls: () => dispatch({ type: 'touchControls' }) }), [dispatch]);
  useEffect(() => {
    if (visible) dispatch({ type: 'show' });
  }, [visible, dispatch]);
  useEffect(() => dispatch({ type: 'rules' }), [rules.canHide, dispatch]);
  useEffect(() => {
    const deadline = chromeDeadline(chrome);
    if (deadline === null) return;
    const timer = setTimeout(() => dispatch({ type: 'tick' }), Math.max(0, deadline - Date.now()));
    return () => clearTimeout(timer);
  }, [chrome, dispatch]);
  const controlsHidden = visible && !chrome.controls;
  useEffect(() => onControlsHidden?.(controlsHidden), [controlsHidden, onControlsHidden]);
  useEffect(() => () => onControlsHidden?.(false), [onControlsHidden]);

  const scroll = useAnimatedRef<Animated.ScrollView>();
  const offset = useScrollOffset(scroll);
  const wave: Wave = { shift: useSharedValue(0), clock: useSharedValue(waveDuration), from: useSharedValue(0) };
  const lineTops = useRef<number[]>([]);
  const [viewport, setViewport] = useState(0);
  // Bumped when the sung line is laid out (or laid out again, as when the text size changes).
  const [placed, setPlaced] = useState(0);
  const entering = useRef(true);
  // The sung line's top sits this far down the page: enough for the line before it to show above.
  const anchor = Math.round(Math.min(40 + 26 * fontScale, viewport * 0.3 || Infinity));

  useEffect(() => {
    if (!visible) entering.current = true;
  }, [visible]);

  useEffect(() => {
    const top = lineTops.current[Math.max(0, sung)];
    if (!visible || !following || !viewport || top === undefined) return;
    const target = Math.max(0, top - anchor);
    const enter = entering.current;
    const rise = enter && !reduceMotion ? entrance : 0;
    entering.current = false;
    const { shift, clock, from } = wave;
    const reach = viewport * waveReach;
    const start = Math.max(0, sung - 2);
    scheduleOnUI(() => {
      'worklet';
      const delta = enter ? rise : target - offset.value;
      if (Math.abs(delta) < 1) {
        scrollTo(scroll, 0, target, false);
        return;
      }
      if (!enter && (reduceMotion || Math.abs(delta) > reach)) {
        // A long way (a seek, or back from reading ahead) scrolls there; Reduce Motion jumps.
        shift.value = 0;
        scrollTo(scroll, 0, target, !reduceMotion);
        return;
      }
      // Jump the page there and hold each line where it was, then let them spring into place.
      const left = shift.value * springRemaining(clock.value);
      scrollTo(scroll, 0, target, false);
      from.value = start;
      shift.value = Math.max(-reach, Math.min(reach, delta + left));
      clock.value = 0;
      clock.value = withTiming(waveDuration, { duration: waveDuration, easing: Easing.linear, reduceMotion: ReduceMotion.Never },
        (finished) => { if (finished) shift.value = 0; });
    });
    // `wave`'s values and `scroll` are stable; `placed` re-runs this once the sung line has a place.
  }, [sung, visible, following, viewport, placed, anchor, reduceMotion]);

  // Which way a reader scrolls, read on the UI thread: on through the lyrics hides the
  // transport and back up brings it back, told to JS only when the way turns.
  const reading = useSharedValue(false);
  const run = useSharedValue(0);
  const heading = useSharedValue(0);
  const scrollable = useSharedValue(0);
  useAnimatedReaction(() => offset.value, (now, before) => {
    if (!reading.value || before === null) return;
    // The bounce past either end springs back the other way; it is not the reader turning.
    if (now < 0 || before < 0 || now > scrollable.value || before > scrollable.value) return;
    run.value = scrollRun(run.value, now - before);
    if (Math.abs(run.value) < scrollTurn) return;
    const way = Math.sign(run.value);
    if (way === heading.value) return;
    heading.value = way;
    scheduleOnRN(dispatch, { type: way > 0 ? 'scroll' : 'scrollBack' });
  });

  const momentum = useRef(false);
  const dragged = useRef(false);
  const contentHeight = useRef(0);
  const rest = () => {
    reading.value = false;
    dispatch({ type: 'rest' });
  };
  const actionsRef = useRef(actions);
  actionsRef.current = actions;
  const seek = useCallback((startMs: number) => {
    selectionFeedback();
    actionsRef.current.seek(startMs);
  }, []);
  const watched = Math.max(0, sung);
  const watchedRef = useRef(watched);
  watchedRef.current = watched;
  const lineLaidOut = useCallback((index: number, top: number) => {
    lineTops.current[index] = top;
    if (index === watchedRef.current) setPlaced(count => count + 1);
  }, []);

  if (!lines.length) return <View style={styles.page}><LyricsEmpty lyrics={lyrics} /></View>;

  return (
    <View style={styles.page}
      // A tap anywhere on the lyrics, a line included, brings the transport back and the page to the sung line.
      onTouchStart={() => { dragged.current = false; }}
      onTouchEnd={() => { if (!dragged.current) dispatch({ type: 'tap' }); }}>
      <Animated.ScrollView
        ref={scroll}
        contentInsetAdjustmentBehavior="never"
        onLayout={(event) => {
          setViewport(event.nativeEvent.layout.height);
          scrollable.value = contentHeight.current - event.nativeEvent.layout.height;
        }}
        onContentSizeChange={(_, height) => {
          contentHeight.current = height;
          scrollable.value = height - viewport;
        }}
        contentContainerStyle={[styles.content, { paddingTop: anchor, paddingBottom: screenHeight * 0.6 }]}
        scrollsToTop={false}
        onScrollBeginDrag={() => {
          dragged.current = true;
          run.value = 0;
          heading.value = 0;
          reading.value = true;
          dispatch({ type: 'grab' });
        }}
        onMomentumScrollBegin={() => { momentum.current = true; }}
        // A drag that ends without a fling has come to rest; one with a fling rests when its momentum ends.
        onScrollEndDrag={({ nativeEvent }) => {
          momentum.current = false;
          if (!nativeEvent.velocity?.y) rest();
        }}
        onMomentumScrollEnd={() => {
          if (!momentum.current) return;
          momentum.current = false;
          rest();
        }}
      >
        {lines.map((line, index) => {
          // Before the first line is sung (`sung` is -1), it waits dim at the top like the rest.
          const look = lineLook(timed ? index - sung : null, { browsing, blur: blurs });
          return <LyricRow key={index} index={index} text={line.text} startMs={line.startMs} active={timed && index === sung}
            opacity={look.opacity} blur={look.blur} delay={following && timed && !reduceMotion ? lineDelay(index, Math.max(0, sung - 2)) : 0}
            wave={wave} onSeek={seek} onLayout={lineLaidOut} watched={index === watched} />;
        })}
        {credits && <Riding index={lines.length} wave={wave}>
          <LyricCredits credits={credits} opacity={browsing ? 0.62 : 0.45} />
        </Riding>}
      </Animated.ScrollView>
    </View>
  );
}

type LyricRowProps = {
  index: number;
  text: string;
  startMs: number | null;
  active: boolean;
  opacity: number;
  blur: number;
  delay: number;
  wave: Wave;
  onSeek: (startMs: number) => void;
  onLayout: (index: number, top: number) => void;
  /** The sung line reports where it is laid out, so the page can keep it at the top. */
  watched: boolean;
};

/** Line `index`'s place in the wave: held where it was, then sprung home a moment after the line above. */
function useWaveStyle(index: number, wave: Wave) {
  return useAnimatedStyle(() => {
    const shift = wave.shift.value;
    if (!shift) return { transform: [{ translateY: 0 }] };
    return { transform: [{ translateY: shift * springRemaining(wave.clock.value - lineDelay(index, wave.from.value)) }] };
  });
}

/** What follows the lines (the credits) rides the wave as the line after the last. */
function Riding({ index, wave, children }: PropsWithChildren<{ index: number; wave: Wave }>) {
  return <Animated.View style={useWaveStyle(index, wave)}>{children}</Animated.View>;
}

const LyricRow = memo(function LyricRow({ index, text, startMs, active, opacity, blur, delay, wave, onSeek, onLayout, watched }: LyricRowProps) {
  const style = useWaveStyle(index, wave);
  const top = useRef<number | null>(null);
  const laidOut = (event: LayoutChangeEvent) => {
    top.current = event.nativeEvent.layout.y;
    onLayout(index, top.current);
  };
  // A line laid out before it was sung reports its place once its turn comes.
  useEffect(() => {
    if (watched && top.current !== null) onLayout(index, top.current);
  }, [watched, index, onLayout]);
  return (
    <Animated.View style={style} onLayout={laidOut}>
      <LyricButton line={text} active={active} opacity={opacity} blur={blur} delay={delay}
        onPress={startMs === null ? undefined : () => onSeek(startMs)} />
    </Animated.View>
  );
}, (before, after) => before.text === after.text && before.startMs === after.startMs && before.active === after.active &&
  before.opacity === after.opacity && before.blur === after.blur && before.delay === after.delay && before.watched === after.watched &&
  before.index === after.index && before.onSeek === after.onSeek && before.onLayout === after.onLayout);

const styles = StyleSheet.create({
  page: { flex: 1 },
  content: { paddingHorizontal: 25 },
});
