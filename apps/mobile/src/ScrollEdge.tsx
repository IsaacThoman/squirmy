import { StyleSheet, View } from 'react-native';
import type { SharedValue } from 'react-native-reanimated';
import { EdgeFade } from './edgeFade';

export type ScrollEdgeProps = {
  /** Fully on down to here, usually the status bar's height. */
  solid: number;
  /** Then fading out over this much. */
  fade: number;
  /** Keep the iOS blur clear until scrolling brings content up behind it. */
  scrollOffset?: SharedValue<number>;
  /** Space from the status bar to the scroll content when at rest. */
  contentGap?: number;
};

/** A soft top edge for content scrolling under the status bar. Without the blur, a fade of the page colour. */
export function ScrollEdge({ solid, fade }: ScrollEdgeProps) {
  return <View pointerEvents="none" style={[styles.edge, { height: solid + fade }]}><EdgeFade solid={solid} fade={fade} /></View>;
}

const styles = StyleSheet.create({ edge: { position: 'absolute', top: 0, left: 0, right: 0, zIndex: 1 } });
