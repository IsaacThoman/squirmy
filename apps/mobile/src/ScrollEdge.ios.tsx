import { Host, Mask, Rectangle, ZStack } from '@expo/ui/swift-ui';
import { accessibilityHidden, foregroundStyle } from '@expo/ui/swift-ui/modifiers';
import { useEffect, useMemo, useState } from 'react';
import { AccessibilityInfo, StyleSheet, View } from 'react-native';
import { EdgeFade, edgeStops } from './edgeFade';
import type { ScrollEdgeProps } from './ScrollEdge';
import { useColors } from './theme';

const material = foregroundStyle({ type: 'material', material: 'ultraThin' });
/** How much of the page colour lies over the blur: content under the status bar dims a little as well as blurs. */
const dim = '99';

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
 * A soft top edge, as the system draws under its bars: content scrolling under the status bar
 * blurs and dims, more towards the top, with no line where it starts. It is static; nothing in
 * it changes as the page scrolls. With Reduce Transparency, a fade of the page colour instead.
 */
export function ScrollEdge({ solid, fade }: ScrollEdgeProps) {
  const colors = useColors();
  const reduce = useReduceTransparency();
  const mask = useMemo(() => foregroundStyle({
    type: 'linearGradient', colors: edgeStops(solid, fade), startPoint: { x: 0.5, y: 0 }, endPoint: { x: 0.5, y: 1 },
  }), [solid, fade]);
  return <View pointerEvents="none" style={[styles.edge, { height: solid + fade }]}>
    {reduce ? <EdgeFade solid={solid} fade={fade} /> : (
      <Host ignoreSafeArea="container" style={StyleSheet.absoluteFill}>
        <Mask modifiers={[accessibilityHidden(true)]}>
          <ZStack>
            <Rectangle modifiers={[material]} />
            <Rectangle modifiers={[foregroundStyle(`${colors.background}${dim}`)]} />
          </ZStack>
          <Mask.Content>
            <Rectangle modifiers={[mask]} />
          </Mask.Content>
        </Mask>
      </Host>
    )}
  </View>;
}

const styles = StyleSheet.create({ edge: { position: 'absolute', top: 0, left: 0, right: 0, zIndex: 1 } });
