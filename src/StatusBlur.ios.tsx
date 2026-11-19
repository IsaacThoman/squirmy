import { Host, Mask, Rectangle } from '@expo/ui/swift-ui';
import { accessibilityHidden, foregroundStyle } from '@expo/ui/swift-ui/modifiers';
import { StyleSheet } from 'react-native';
import { statusFade } from './theme';

const material = foregroundStyle({ type: 'material', material: 'ultraThin' });
const fade = foregroundStyle({
  type: 'linearGradient',
  colors: statusFade.map(alpha => `#FFFFFF${alpha}`),
  startPoint: { x: 0.5, y: 0 },
  endPoint: { x: 0.5, y: 1 },
});

/** The app's material, fading out downward, so the status bar stays legible over scrolling content. */
export function StatusBlur() {
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
