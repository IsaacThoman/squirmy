import { Host, Mask, Rectangle } from '@expo/ui/swift-ui';
import { accessibilityHidden, foregroundStyle } from '@expo/ui/swift-ui/modifiers';
import { StyleSheet } from 'react-native';
import { useColors } from '../theme';

const material = foregroundStyle({ type: 'material', material: 'ultraThin' });
const mask = (colors: string[]) => foregroundStyle({
  type: 'linearGradient',
  colors,
  startPoint: { x: 0.5, y: 0 },
  endPoint: { x: 0.5, y: 1 },
});
const fade = mask(['#FFFFFF', '#FFFFFFF0', '#FFFFFF80', '#FFFFFF00']);
// A bar: solid, softening only along its bottom edge. The stops are evenly spaced, so the
// softening takes the last tenth, the strip below the buttons; any more and rows scrolling
// up would show through behind the title and buttons.
const bar = mask([...Array<string>(10).fill('#FFFFFF'), '#FFFFFF00']);

/** A blur behind the status bar that fades out downwards; `solid` makes it a navigation bar. */
export function AlbumStatusBlur({ solid = false }: { solid?: boolean }) {
  const colors = useColors();
  return (
    <Host ignoreSafeArea="container" style={StyleSheet.absoluteFill}>
      <Mask modifiers={[accessibilityHidden(true)]}>
        {/* The bar is the page colour: under any material, titles and buttons scrolling beneath
            it read through behind its own title. Only its softened bottom edge lets them show. */}
        {solid ? <Rectangle modifiers={[foregroundStyle(colors.background)]} /> : <Rectangle modifiers={[material]} />}
        <Mask.Content>
          <Rectangle modifiers={[solid ? bar : fade]} />
        </Mask.Content>
      </Mask>
    </Host>
  );
}
