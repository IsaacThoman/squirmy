import { useEffect, useRef, useState, type Ref } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useTrackLyrics } from './useTrackLyrics';
import { secondaryFontScale } from '../fontScale';
import { usePlaybackState, usePosition } from '../playback';
import { createThemedStyles, useColors } from '../theme';
import { Icon } from '../ui';
import { LyricButton } from './Controls';
import LyricsEmpty from './LyricsEmpty';
import { selectionFeedback } from './design';
import { activeLine, lineInView, lyricLines } from './lyrics';
import { usePlayerShown } from './visibility';

/** What Now Playing can tell the lyrics page: a touch on the transport, which keeps it up. */
export type LyricsHandle = { touchControls: () => void };

export type LyricsProps = {
  selected: boolean;
  ref?: Ref<LyricsHandle>;
  /** A side pane has its own room, so the transport can stay visible beside it. */
  keepControls?: boolean;
  /** The page hides the transport while lyrics play untouched, and shows it again; see `lyricsChrome`. */
  onControlsHidden?: (hidden: boolean) => void;
};

/**
 * Lyrics under Now Playing's transport, which stays up. iOS has its own page, drawn as Apple
 * Music's: `LyricsPage.ios.tsx`.
 */
export default function LyricsPage({ selected }: LyricsProps) {
  const colors = useColors();
  const styles = useStyles();
  const shown = usePlayerShown();
  const visible = selected && shown;
  const { track, actions } = usePlaybackState();
  const lyrics = useTrackLyrics(track);
  const { lines, synced } = lyricLines(lyrics.data);
  const position = usePosition(visible && synced);
  const active = synced ? Math.max(0, activeLine(lines, position)) : -1;
  const scroll = useRef<React.ComponentRef<typeof ScrollView>>(null);
  const lineCenters = useRef<number[]>([]);
  const [viewport, setViewport] = useState(0);
  // Whether the active line has been laid out. Lines lay out after the page appears, and while
  // paused the active line never changes, so without this the page would open on the first
  // lines with the current one somewhere below.
  const [placed, setPlaced] = useState(false);
  // Scrolling by hand stops the page following the song, so a reader can look ahead or back;
  // "Back to current line" resumes it, and so does scrolling back to the sung line, tapping a
  // line or leaving the page. No timer pulls a reader back while they read.
  const [following, setFollowing] = useState(true);
  const momentum = useRef(false);
  const follows = following || !synced;

  useEffect(() => {
    if (!visible) setFollowing(true);
  }, [visible]);

  useEffect(() => {
    const center = lineCenters.current[active];
    if (visible && follows && viewport && center !== undefined) {
      scroll.current?.scrollTo({ y: Math.max(0, center - viewport * 0.33), animated: active > 0 });
    }
  }, [active, visible, viewport, placed, follows]);

  const browse = () => setFollowing(false);
  const settle = (offset: number) => {
    if (lineInView(lineCenters.current[active], offset, viewport)) setFollowing(true);
  };

  return (
    <View style={styles.lyricPage}>
      {lines.length ? (
        <ScrollView
          ref={scroll}
          contentInsetAdjustmentBehavior="never"
          onLayout={(event) => setViewport(event.nativeEvent.layout.height)}
          contentContainerStyle={{ paddingTop: 22, paddingBottom: viewport * 0.6 }}
          showsVerticalScrollIndicator={false}
          onScrollBeginDrag={browse}
          onMomentumScrollBegin={() => { momentum.current = true; }}
          // A drag that ends without a fling has come to rest; one with a fling rests when its momentum ends.
          onScrollEndDrag={({ nativeEvent }) => {
            momentum.current = false;
            if (!nativeEvent.velocity?.y) settle(nativeEvent.contentOffset.y);
          }}
          onMomentumScrollEnd={({ nativeEvent }) => {
            if (!momentum.current) return;
            momentum.current = false;
            settle(nativeEvent.contentOffset.y);
          }}
        >
          {lines.map((line, index) => (
            <View key={index} onLayout={(event) => {
              const { y, height } = event.nativeEvent.layout;
              lineCenters.current[index] = y + height / 2;
              if (index === active) setPlaced(true);
            }}>
              <LyricButton line={line.text} active={!synced || index === active}
                onPress={line.startMs === null ? undefined : () => { selectionFeedback(); setFollowing(true); actions.seek(line.startMs!); }} />
            </View>
          ))}
        </ScrollView>
      ) : <LyricsEmpty lyrics={lyrics} />}
      {lines.length > 0 && !follows && (
        <Pressable accessibilityRole="button" onPress={() => { selectionFeedback(); setFollowing(true); }}
          style={({ pressed }) => [styles.backToLine, pressed && styles.pressed]}>
          <Icon name="arrow.up.arrow.down" size={14} color={colors.accent} />
          <Text maxFontSizeMultiplier={secondaryFontScale} style={styles.backToLineText}>Back to current line</Text>
        </Pressable>
      )}
    </View>
  );
}

const useStyles = createThemedStyles(colors => StyleSheet.create({
  lyricPage: { flex: 1, paddingHorizontal: 25 },
  // Floats over the lyrics' bottom edge, clear of the lines' own touches, 44 pt tall.
  backToLine: { position: 'absolute', bottom: 12, alignSelf: 'center', flexDirection: 'row', alignItems: 'center', gap: 7, minHeight: 44,
    paddingHorizontal: 18, borderRadius: 22, backgroundColor: colors.sheet, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.stroke },
  backToLineText: { color: colors.accent, fontSize: 15, fontWeight: '700' },
  pressed: { opacity: 0.65 },
}));
