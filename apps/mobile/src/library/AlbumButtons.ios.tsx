import { Button, Host, HStack, Image, ProgressView, Text } from '@expo/ui/swift-ui';
import {
  accessibilityHidden, accessibilityLabel, background, buttonBorderShape, buttonStyle, clipShape, contentShape, dynamicTypeSize, font,
  foregroundStyle, frame, lineLimit, padding, progressViewStyle, shapes, tint,
} from '@expo/ui/swift-ui/modifiers';
import { isLiquidGlassAvailable } from 'expo-glass-effect';
import type { ComponentProps } from 'react';
import type { AlbumNavProps, AlbumPlaybackProps } from './AlbumButtons';
import { useColors } from '../theme';

type SymbolName = ComponentProps<typeof Image>['systemName'];
const hitShape = contentShape(shapes.rectangle());

export function AlbumNavButton({ icon, label, onPress, selected, busy }: AlbumNavProps) {
  const colors = useColors();
  const glass = isLiquidGlassAvailable();
  // The glass adds its own padding around the content: 30 inside makes the button 44 across,
  // the smallest target Apple recommends (26 made it 40).
  const size = frame(glass ? { width: 30, height: 30 } : { width: 44, height: 44 });
  return (
    <Host style={{ width: 44, height: 44 }}>
      <Button onPress={onPress} modifiers={glass
        ? [buttonStyle('glass'), buttonBorderShape('circle'), accessibilityLabel(label)]
        : [buttonStyle('plain'), background(colors.surface), clipShape('circle'), accessibilityLabel(label)]}>
        {busy
          ? <ProgressView modifiers={[progressViewStyle('circular'), tint(colors.text), size, hitShape]} />
          // The button carries the label; left alone, the image would announce its symbol's name.
          : <Image systemName={icon as SymbolName} size={20} color={selected ? colors.accent : colors.text} modifiers={[size, hitShape, accessibilityHidden(true)]} />}
      </Button>
    </Host>
  );
}

export function AlbumPlaybackButtons({ title, actions }: AlbumPlaybackProps) {
  const colors = useColors();
  return (
    // As tall as the labels need: they follow the reader's text size, up to where two still fit side by side.
    <Host matchContents={{ vertical: true }} style={{ marginTop: 18, alignSelf: 'stretch' }}>
      <HStack spacing={9} modifiers={[dynamicTypeSize({ max: 'accessibility2' })]}>
        {actions.map(({ label, symbol, onPress, busy }, index) => {
          const color = index === 0 ? colors.onAccent : colors.text;
          return <Button key={label} onPress={onPress}
            modifiers={[buttonStyle('plain'), background(index === 0 ? colors.accent : colors.surface), clipShape('capsule'), accessibilityLabel(`${label} ${title}`)]}>
            <HStack spacing={8} modifiers={[frame({ maxWidth: Infinity }), frame({ minHeight: 46 }), padding({ vertical: 6 }), hitShape]}>
              {busy
                ? <ProgressView modifiers={[progressViewStyle('circular'), tint(color), frame({ width: 17, height: 17 })]} />
                : <Image systemName={symbol as SymbolName} color={color} size={17} />}
              <Text modifiers={[foregroundStyle(color), font({ textStyle: 'subheadline', weight: 'bold' }), lineLimit(1)]}>{label}</Text>
            </HStack>
          </Button>;
        })}
      </HStack>
    </Host>
  );
}
