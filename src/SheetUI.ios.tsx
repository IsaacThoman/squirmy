import { Button, Divider, Host, HStack, Spacer, Text, VStack } from '@expo/ui/swift-ui';
import {
  accessibilityAddTraits, accessibilityLabel, font, foregroundStyle, frame, lineLimit, padding,
} from '@expo/ui/swift-ui/modifiers';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { tracks } from './catalog';
import { IconButton, Symbol, TrackCover, hitShape, plainButton } from './native/Controls';
import { colors } from './ui';
import type { SheetFrameProps, SheetRowProps } from './SheetUI';

export function SheetFrame({ title, onClose, children }: SheetFrameProps) {
  const { bottom } = useSafeAreaInsets();
  return <Host colorScheme="dark" matchContents={{ vertical: true }}>
    <VStack alignment="leading" spacing={14} modifiers={[padding({ top: 22, horizontal: 22, bottom: Math.max(23, bottom + 8) })]}>
      <HStack spacing={8}>
        <Text modifiers={[font({ textStyle: 'title2', weight: 'bold' }), accessibilityAddTraits(['isHeader'])]}>{title}</Text>
        <Spacer minLength={0} />
        <IconButton symbol="xmark.circle.fill" label="Close" size={26} color={colors.muted} onPress={onClose} />
      </HStack>
      {children}
    </VStack>
  </Host>;
}

export function SheetRows({ children }: { children: React.ReactNode }) {
  return <VStack alignment="leading" spacing={0}>{children}</VStack>;
}

export function SheetRow({ title, subtitle, icon, selected, onPress }: SheetRowProps) {
  return <>
    <Button onPress={onPress} modifiers={[
      plainButton, accessibilityLabel(subtitle ? `${title}, ${subtitle}` : title),
      ...(selected ? [accessibilityAddTraits(['isSelected'])] : []),
    ]}>
      <HStack spacing={12} modifiers={[frame({ minHeight: 49 }), hitShape]}>
        <HStack modifiers={[frame({ width: 27 })]}>
          <Symbol name={icon} size={18} color={selected ? colors.accent : colors.muted} />
        </HStack>
        <VStack alignment="leading" spacing={2}>
          <Text modifiers={[font({ textStyle: 'body', weight: 'medium' })]}>{title}</Text>
          {subtitle && <Text modifiers={[font({ textStyle: 'footnote' }), foregroundStyle(colors.muted)]}>{subtitle}</Text>}
        </VStack>
        <Spacer minLength={4} />
        {selected && <Symbol name="checkmark" size={15} color={colors.accent} />}
      </HStack>
    </Button>
    <Divider modifiers={[padding({ leading: 39 })]} />
  </>;
}

export function TrackSummary({ id }: { id: string }) {
  const track = tracks[id];
  return <HStack spacing={12} modifiers={[padding({ bottom: 4 })]}>
    <TrackCover trackId={id} size={53} radius={9} />
    <VStack alignment="leading" spacing={3}>
      <Text modifiers={[font({ textStyle: 'headline' }), lineLimit(1)]}>{track.title}</Text>
      <Text modifiers={[font({ textStyle: 'footnote' }), foregroundStyle(colors.muted), lineLimit(1)]}>{track.artist}</Text>
    </VStack>
    <Spacer minLength={0} />
  </HStack>;
}
