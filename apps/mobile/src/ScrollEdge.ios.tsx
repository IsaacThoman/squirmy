import { requireNativeView } from 'expo';
import { useEffect, useMemo, useState } from 'react';
import { AccessibilityInfo, StyleSheet, type ViewProps } from 'react-native';
import Animated, { Extrapolation, interpolate, useAnimatedStyle } from 'react-native-reanimated';
import { EdgeFade, edgeStops } from './edgeFade';
import type { ScrollEdgeProps } from './ScrollEdge';
import { useAppearance } from './theme';

type ExpoGlobal = { expo?: { getViewConfig?: (moduleName: string) => { validAttributes: Record<string, unknown> } | null } };
type BlurProps = ViewProps & { tint: 'dark' | 'light'; intensity: number; gradientMask: string[] };

const ScrollBlur = (globalThis as ExpoGlobal).expo?.getViewConfig?.('ExpoBlur')?.validAttributes.gradientMask
  ? requireNativeView<BlurProps>('ExpoBlur') : null;

function useReduceTransparency() {
  const [reduce, setReduce] = useState(false);
  useEffect(() => {
    let live = true;
    void AccessibilityInfo.isReduceTransparencyEnabled().then(value => { if (live) setReduce(value); });
    const subscription = AccessibilityInfo.addEventListener('reduceTransparencyChanged', setReduce);
    return () => { live = false; subscription.remove(); };
  }, []);
  return reduce;
}

/**
 * Soften artwork behind the status text and taper the material off within the safe area.
 * Below a pinned header, a shorter fade blends the clipped rows into the page colour.
 */
export function ScrollEdge({ solid, fade, scrollOffset, contentGap = 0 }: ScrollEdgeProps) {
  const appearance = useAppearance();
  const reduce = useReduceTransparency();
  const statusBar = solid > 0;
  const fadeStart = solid * 0.44;
  const blurHeight = statusBar ? solid * 0.86 : fade * 2 / 3;
  const reachesEdge = solid - blurHeight + contentGap;
  const mask = useMemo(() => edgeStops(fadeStart, blurHeight - fadeStart), [fadeStart, blurHeight]);
  const reveal = useAnimatedStyle(() => ({
    opacity: scrollOffset && !reduce
      ? interpolate(scrollOffset.value, [reachesEdge, reachesEdge + 12], [0, 1], Extrapolation.CLAMP) : 1,
  }));
  return <Animated.View pointerEvents="none" style={[styles.edge, { height: reduce ? solid + fade : blurHeight }, reveal]}>
    {!reduce && ScrollBlur && <ScrollBlur tint={appearance} intensity={16} gradientMask={mask} style={StyleSheet.absoluteFill} />}
    {reduce ? <EdgeFade solid={solid} fade={fade} /> : !statusBar && <EdgeFade solid={0} fade={blurHeight} />}
  </Animated.View>;
}

const styles = StyleSheet.create({ edge: { position: 'absolute', top: 0, left: 0, right: 0, zIndex: 1 } });
