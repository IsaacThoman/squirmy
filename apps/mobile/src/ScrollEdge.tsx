import { StyleSheet, View } from 'react-native';
import { EdgeFade } from './edgeFade';

export type ScrollEdgeProps = {
  /** Fully on down to here, usually the status bar's height. */
  solid: number;
  /** Then fading out over this much. */
  fade: number;
};

/** A soft top edge for content scrolling under the status bar. Without the blur, a fade of the page colour. */
export function ScrollEdge({ solid, fade }: ScrollEdgeProps) {
  return <View pointerEvents="none" style={[styles.edge, { height: solid + fade }]}><EdgeFade solid={solid} fade={fade} /></View>;
}

const styles = StyleSheet.create({ edge: { position: 'absolute', top: 0, left: 0, right: 0, zIndex: 1 } });
