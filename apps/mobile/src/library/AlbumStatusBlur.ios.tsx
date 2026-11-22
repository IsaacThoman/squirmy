import { Host, Mask, Rectangle } from '@expo/ui/swift-ui';
import { accessibilityHidden, foregroundStyle } from '@expo/ui/swift-ui/modifiers';
import { StyleSheet } from 'react-native';

const material = foregroundStyle({ type: 'material', material: 'ultraThin' });
const barMaterial = foregroundStyle({ type: 'material', material: 'bar' });
const mask = (colors: string[]) => foregroundStyle({
  type: 'linearGradient',
  colors,
  startPoint: { x: 0.5, y: 0 },
  endPoint: { x: 0.5, y: 1 },
});
const fade = mask(['#FFFFFF', '#FFFFFFF0', '#FFFFFF80', '#FFFFFF00']);
// A bar: full material, softening only along its bottom edge.
const bar = mask(['#FFFFFF', '#FFFFFF', '#FFFFFF', '#FFFFFF', '#FFFFFFE0', '#FFFFFF00']);

/** A blur behind the status bar that fades out downwards; `solid` makes it a navigation bar. */
export function AlbumStatusBlur({ solid = false }: { solid?: boolean }) {
  return (
    <Host ignoreSafeArea="container" style={StyleSheet.absoluteFill}>
      <Mask modifiers={[accessibilityHidden(true)]}>
        <Rectangle modifiers={[solid ? barMaterial : material]} />
        <Mask.Content>
          <Rectangle modifiers={[solid ? bar : fade]} />
        </Mask.Content>
      </Mask>
    </Host>
  );
}
