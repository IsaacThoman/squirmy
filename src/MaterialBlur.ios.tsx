import { Host, Mask, Rectangle } from '@expo/ui/swift-ui';
import { accessibilityHidden, foregroundStyle } from '@expo/ui/swift-ui/modifiers';
import type { MaterialBlurProps } from './MaterialBlur';

const material = foregroundStyle({ type: 'material', material: 'ultraThin' });
const fade = foregroundStyle({
  type: 'linearGradient',
  colors: ['#FFFFFF', '#FFFFFFF0', '#FFFFFF80', '#FFFFFF00'],
  startPoint: { x: 0.5, y: 0 },
  endPoint: { x: 0.5, y: 1 },
});
const hidden = accessibilityHidden(true);

export function MaterialBlur({ style, fadeBottom }: MaterialBlurProps) {
  return (
    <Host colorScheme="dark" ignoreSafeArea="container" pointerEvents="none" style={style}>
      {fadeBottom ? (
        <Mask modifiers={[hidden]}>
          <Rectangle modifiers={[material]} />
          <Mask.Content>
            <Rectangle modifiers={[fade]} />
          </Mask.Content>
        </Mask>
      ) : (
        <Rectangle modifiers={[material, hidden]} />
      )}
    </Host>
  );
}
