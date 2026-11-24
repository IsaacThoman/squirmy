import { Button, Capsule, Host, Image, Menu, Rectangle, Text, VStack } from '@expo/ui/swift-ui';
import {
  accessibilityAddTraits, accessibilityHint, accessibilityLabel, dynamicTypeSize, font, foregroundStyle, frame, lineLimit, menuIndicator,
  menuOrder, minimumScaleFactor, padding,
} from '@expo/ui/swift-ui/modifiers';
import type { ComponentProps } from 'react';
import { StyleSheet, View } from 'react-native';
import { trackActionKey, trackLinks } from '../library/trackActionList';
import { useRunTrackAction } from '../library/trackActions';
import { IconButton, Symbol, TrackMenu, hitShape, plainButton } from '../native/Controls';
import type { DeviceButtonProps, LyricButtonProps, PlayerButtonProps, TrackLinksMenuProps, TrackMenuButtonProps } from './Controls';
import { useColors } from '../theme';

// The heart and menu buttons ignore the safe area: inside the iOS queue's scroll view, where
// the song playing rides with the page, its insets pushed their symbols out of the 44 pt frame
// at accessibility text sizes.
export function PlayerButton({ icon, label, size, color, onPress, style, selected, busy }: PlayerButtonProps) {
  const colors = useColors();
  const { width = 44, height = 44 } = StyleSheet.flatten(style) ?? {};
  return <Host ignoreSafeArea="container" style={[styles.icon, style]}>
    <IconButton symbol={icon} label={label} size={size} color={color ?? colors.text} onPress={onPress} selected={selected} busy={busy}
      width={Number(width)} height={Number(height)} />
  </Host>;
}

/** The grabber, 14 pt from the top of a 44 pt target that reaches below the 32 pt row it is drawn in. */
export function CollapseButton({ onPress }: { onPress: () => void }) {
  const colors = useColors();
  return <Host style={{ width: 105, height: 44 }}>
    <Button onPress={onPress} modifiers={[plainButton, accessibilityLabel('Collapse player')]}>
      <Capsule modifiers={[foregroundStyle(colors.grabber), frame({ width: 32, height: 4 }), padding({ top: 14 }),
        frame({ width: 105, height: 44, alignment: 'top' }), hitShape]} />
    </Button>
  </Host>;
}

export function TrackMenuButton({ track }: TrackMenuButtonProps) {
  const colors = useColors();
  return <Host ignoreSafeArea="container" style={styles.icon}><TrackMenu track={track} label="Song options" color={colors.text} /></Host>;
}

/**
 * The title and artist as drawn by React Native, with a system menu over them, as in Apple
 * Music: "Go to album" and "Go to artist" (one for each credited artist), each naming where it
 * goes, and only for pages that exist. Choosing one closes Now Playing and opens the page.
 */
export function TrackLinksMenu({ track, accessibilityLabel: label, children }: TrackLinksMenuProps) {
  const run = useRunTrackAction(false);
  const links = track ? trackLinks(track) : [];
  if (!links.length) return <>{children}</>;
  return <View style={styles.links}>
    <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants">{children}</View>
    <Host style={StyleSheet.absoluteFill}>
      <Menu label={<Rectangle modifiers={[foregroundStyle('transparent'), frame({ maxWidth: Infinity, maxHeight: Infinity }), hitShape]} />}
        // The album first, then the artists, whichever way the menu opens.
        modifiers={[plainButton, menuIndicator('hidden'), menuOrder('fixed'), accessibilityLabel(label), accessibilityHint('Shows the album and artist')]}>
        {links.map(link => <Button key={trackActionKey(link)} onPress={() => run(link)}>
          <Text>{link.id === 'album' ? 'Go to album' : 'Go to artist'}</Text>
          <Text>{link.subtitle ?? ''}</Text>
          <Image systemName={link.icon as SymbolName} />
        </Button>)}
      </Menu>
    </Host>
  </View>;
}

type SymbolName = ComponentProps<typeof Image>['systemName'];

export function DeviceButton({ icon, name, highlighted, onPress }: DeviceButtonProps) {
  const colors = useColors();
  const color = highlighted ? colors.accent : colors.muted;
  return <Host style={styles.device}>
    <Button onPress={onPress} modifiers={[plainButton, accessibilityLabel(`Playback device: ${name}`)]}>
      {/* The footer is a fixed 56 pt tall, so the label stops growing before it overflows it. */}
      <VStack spacing={5} modifiers={[frame({ maxWidth: Infinity, minHeight: 44 }), hitShape, dynamicTypeSize({ max: 'xxxLarge' })]}>
        <Symbol name={icon} size={21} color={color} />
        {/* Shrinks a little rather than cut "Only on this device" short at the largest sizes. */}
        <Text modifiers={[foregroundStyle(color), font({ textStyle: 'caption2', weight: 'semibold' }), lineLimit(1),
          minimumScaleFactor(0.8)]}>{name}</Text>
      </VStack>
    </Button>
  </Host>;
}

export function LyricButton({ line, active, onPress }: LyricButtonProps) {
  const colors = useColors();
  const text = <Text modifiers={[
    foregroundStyle(active ? colors.text : colors.quiet), font({ textStyle: 'largeTitle', weight: 'bold' }),
    frame({ maxWidth: Infinity, alignment: 'leading' }), padding({ bottom: 20 }), hitShape,
  ]}>{line}</Text>;
  return <View style={styles.lyricRow}>
    <Host matchContents={{ vertical: true }}>
      {onPress ? <Button onPress={onPress} modifiers={[
        plainButton, accessibilityHint('Seek to this line'),
        ...(active ? [accessibilityAddTraits(['isSelected'])] : []),
      ]}>{text}</Button> : text}
    </Host>
  </View>;
}

const styles = StyleSheet.create({
  icon: { width: 44, height: 44 },
  device: { height: 56 },
  // At least 44 pt to touch, however short the lines.
  links: { minHeight: 44, justifyContent: 'center' },
  lyricRow: { width: '100%', maxWidth: 530 },
});
