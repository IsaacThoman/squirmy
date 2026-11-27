import type { Artwork } from '@squirmy/contracts';
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { useIsFocused } from 'expo-router';
import { memo, useEffect, useRef } from 'react';
import { Animated, Easing, StyleSheet, View } from 'react-native';
import { useArtworkImage } from '../../data/artwork';
import { shade } from '../../data/color';
import { colors } from '../theme';

/** Wider than the screen's diagonal, so a turned layer always covers its corners. */
const layer = 2400;
/** One slow turn of the colours, as the system's music app keeps its backdrop moving. */
const turnMs = 120_000;
/** The colours fade from one song's to the next's over this long. */
const fadeMs = 900;

/**
 * Now Playing's backdrop, made from the cover: its colours spread across the screen, blurred
 * past recognition and darkened so white type stays readable, turning slowly. The cover's
 * ThumbHash is already that blur, so it is drawn as is; a cover without one is blurred here.
 * The turning is two transforms on the native driver: nothing is redrawn while it moves. It
 * stops while Now Playing is not on screen (the tab stays mounted) and goes on from where it was.
 */
export const Ambience = memo(function Ambience({ artwork }: { artwork: Artwork | null | undefined }) {
  const image = useArtworkImage(artwork, 64);
  const source = artwork?.thumbhash ? { thumbhash: artwork.thumbhash } : image?.source;
  const blur = artwork?.thumbhash ? 0 : 40;
  const turn = useRef(new Animated.Value(0)).current;
  const stoppedAt = useRef(0);
  const onScreen = useIsFocused();
  useEffect(() => {
    if (!onScreen) return;
    let running = true;
    // A whole turn looks the same as none, so each one starts again from 0 without a jump.
    const spin = (from: number) => {
      turn.setValue(from);
      Animated.timing(turn, { toValue: 1, duration: turnMs * (1 - from), easing: Easing.linear, useNativeDriver: true })
        .start(({ finished }) => { if (finished && running) spin(0); });
    };
    spin(stoppedAt.current);
    return () => {
      running = false;
      turn.stopAnimation(value => { stoppedAt.current = value; });
    };
  }, [onScreen, turn]);
  const forward = turn.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] });
  const back = turn.interpolate({ inputRange: [0, 1], outputRange: ['180deg', '-180deg'] });
  const tint = artwork?.color;
  return <View pointerEvents="none" style={styles.fill}>
    <LinearGradient colors={[shade(tint, 0.8), shade(tint, 0.4)]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={StyleSheet.absoluteFill} />
    {source && <>
      <Animated.View style={[styles.layer, { transform: [{ rotate: forward }, { scale: 1.1 }] }]}>
        <Image source={source} blurRadius={blur} contentFit="cover" transition={fadeMs} style={StyleSheet.absoluteFill} />
      </Animated.View>
      <Animated.View style={[styles.layer, styles.second, { transform: [{ rotate: back }, { scaleX: -1 }] }]}>
        <Image source={source} blurRadius={blur} contentFit="cover" transition={fadeMs} style={StyleSheet.absoluteFill} />
      </Animated.View>
    </>}
    {/* Darker toward the bottom, where the controls and the small type are. */}
    <LinearGradient colors={['rgba(8,6,14,0.16)', 'rgba(8,6,14,0.34)', 'rgba(8,6,14,0.7)']} locations={[0, 0.55, 1]}
      style={StyleSheet.absoluteFill} />
  </View>;
});

const styles = StyleSheet.create({
  fill: { ...StyleSheet.absoluteFill, overflow: 'hidden', backgroundColor: colors.background },
  layer: { position: 'absolute', width: layer, height: layer, left: (1920 - layer) / 2, top: (1080 - layer) / 2 },
  second: { opacity: 0.7 },
});
