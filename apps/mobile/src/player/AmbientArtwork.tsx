import type { Artwork } from '@squirmy/contracts';
import { Image } from 'expo-image';
import { memo, useEffect } from 'react';
import { StyleSheet, useWindowDimensions, View } from 'react-native';
import Animated, { cancelAnimation, Easing, ReduceMotion, useAnimatedStyle, useReducedMotion, useSharedValue, withTiming } from 'react-native-reanimated';
import { useArtworkImage } from '../data/artwork';
import { useAppActive, useIsPlaying } from '../playback';
import { usePlayerShown } from './visibility';

/** One slow turn of the colours, as on the Apple TV (`tv/player/Ambience.tsx`). */
const turnMs = 120_000;
/** The colours fade from one song's to the next's over this long. */
const fadeMs = 900;
/** Turns queued in one go; the clock is a count of turns, so stopping and going on never jumps. */
const turnsAhead = 1000;

/**
 * Now Playing's backdrop on the phone, as on the Apple TV: the cover's colours spread across the
 * screen, blurred past recognition, in two layers turning slowly against each other. The cover's
 * ThumbHash is already that blur, so it is drawn as is, a few dozen pixels scaled up; a cover
 * without one is blurred once by expo-image. The turning is two transforms on the UI thread:
 * nothing is laid out or redrawn while it moves.
 *
 * It turns only while Now Playing is up, the app is on screen and the music plays, goes on from
 * where it stopped, and stands still under Reduce Motion. The player's gradient over it keeps
 * the text readable, as it did over the still backdrop.
 */
export const AmbientArtwork = memo(function AmbientArtwork({ artwork }: { artwork: Artwork | null | undefined }) {
  const image = useArtworkImage(artwork, 96);
  const source = artwork?.thumbhash ? { thumbhash: artwork.thumbhash } : image?.source;
  const blur = artwork?.thumbhash ? 0 : 30;
  const { width, height } = useWindowDimensions();
  // Wider than the window's diagonal, so a turned layer always covers its corners.
  const side = Math.ceil(Math.hypot(width, height) * 1.08);
  const turn = useSharedValue(0);
  const shown = usePlayerShown();
  const active = useAppActive();
  const playing = useIsPlaying();
  const reduceMotion = useReducedMotion();
  const turning = shown && active && playing && !reduceMotion;
  useEffect(() => {
    if (!turning) return;
    turn.value = withTiming(turn.value + turnsAhead, {
      duration: turnMs * turnsAhead, easing: Easing.linear, reduceMotion: ReduceMotion.Never,
    });
    return () => cancelAnimation(turn);
  }, [turning, turn]);
  const forward = useAnimatedStyle(() => ({ transform: [{ rotate: `${(turn.value % 1) * 360}deg` }, { scale: 1.1 }] }));
  const back = useAnimatedStyle(() => ({ transform: [{ rotate: `${180 - (turn.value % 1) * 360}deg` }, { scaleX: -1 }] }));
  const layer = { width: side, height: side, left: (width - side) / 2, top: (height - side) / 2 };
  if (!source) return null;
  return <View pointerEvents="none" style={styles.fill}>
    <Animated.View style={[styles.layer, layer, forward]}>
      <Image source={source} blurRadius={blur} contentFit="cover" transition={fadeMs} style={StyleSheet.absoluteFill} />
    </Animated.View>
    <Animated.View style={[styles.layer, layer, styles.second, back]}>
      <Image source={source} blurRadius={blur} contentFit="cover" transition={fadeMs} style={StyleSheet.absoluteFill} />
    </Animated.View>
  </View>;
});

const styles = StyleSheet.create({
  fill: { ...StyleSheet.absoluteFill, overflow: 'hidden' },
  layer: { position: 'absolute' },
  second: { opacity: 0.7 },
});
