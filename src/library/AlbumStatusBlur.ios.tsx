import { Host, Mask, Rectangle } from '@expo/ui/swift-ui';
import { accessibilityHidden, foregroundStyle } from '@expo/ui/swift-ui/modifiers';
import { StyleSheet } from 'react-native';

const material = foregroundStyle({ type: 'material', material: 'ultraThin' });
const fade = foregroundStyle({
  type: 'linearGradient',
  colors: ['#FFFFFF', '#FFFFFFF0', '#FFFFFF80', '#FFFFFF00'],
  startPoint: { x: 0.5, y: 0 },
  endPoint: { x: 0.5, y: 1 },
});

export function AlbumStatusBlur() {
  return (
    <Host ignoreSafeArea="container" style={StyleSheet.absoluteFill}>
      <Mask modifiers={[accessibilityHidden(true)]}>
        <Rectangle modifiers={[material]} />
        <Mask.Content>
          <Rectangle modifiers={[fade]} />
        </Mask.Content>
      </Mask>
    </Host>
  );
}
