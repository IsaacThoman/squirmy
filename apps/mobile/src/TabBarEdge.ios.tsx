import { Host, Mask, Rectangle, ZStack } from '@expo/ui/swift-ui';
import { accessibilityHidden, foregroundStyle } from '@expo/ui/swift-ui/modifiers';
import { StyleSheet, View } from 'react-native';
import { useColors } from './theme';

const material = foregroundStyle({ type: 'material', material: 'thin' });
// Clear at the top, about half on at the mini-player's top edge, fully on behind its middle.
const mask = foregroundStyle({
  type: 'linearGradient',
  colors: ['#FFFFFF00', '#FFFFFFAA', '#FFFFFFF0', '#FFFFFF', '#FFFFFF', '#FFFFFF'],
  startPoint: { x: 0.5, y: 0 },
  endPoint: { x: 0.5, y: 1 },
});
/**
 * How much of the page colour lies over the blur. The glass bars magnify what is under them,
 * so covers and titles scrolled there read through as clearly as the bars' own labels; under
 * this much they are only colour and shape, the way the system's scroll edge treats content
 * under a tab bar.
 */
const fill = 'B3';

/**
 * A soft edge at the bottom of the screen, under the glass tab bar and the mini-player:
 * content scrolling under them blurs and dims, so their labels stay legible.
 */
export function TabBarEdge({ height }: { height: number }) {
  const colors = useColors();
  if (height <= 0) return null;
  return <View pointerEvents="none" style={[styles.edge, { height }]}>
    <Host ignoreSafeArea="container" style={StyleSheet.absoluteFill}>
      <Mask modifiers={[accessibilityHidden(true)]}>
        <ZStack>
          <Rectangle modifiers={[material]} />
          <Rectangle modifiers={[foregroundStyle(`${colors.background}${fill}`)]} />
        </ZStack>
        <Mask.Content>
          <Rectangle modifiers={[mask]} />
        </Mask.Content>
      </Mask>
    </Host>
  </View>;
}

const styles = StyleSheet.create({ edge: { position: 'absolute', left: 0, right: 0, bottom: 0 } });
