import { Image, type ImageSource } from 'expo-image';
import { SymbolView, type AndroidSymbol } from 'expo-symbols';
import type { ComponentProps } from 'react';
import { type ColorValue, type StyleProp, type ViewStyle } from 'react-native';
import { useColors } from './theme';

type AppleSymbol = Extract<ComponentProps<typeof SymbolView>['name'], string>;

const material: Record<string, AndroidSymbol> = {
  'airplay.audio': 'cast', 'arrow.down': 'arrow_downward', 'arrow.up.arrow.down': 'swap_vert',
  'checkmark': 'check', 'checkmark.circle.fill': 'check_circle', 'chevron.down': 'expand_more',
  'chevron.left': 'chevron_left', 'chevron.right': 'chevron_right',
  'chevron.up.chevron.down': 'unfold_more', 'clock.arrow.circlepath': 'history',
  'ellipsis': 'more_horiz', 'forward.fill': 'fast_forward', 'backward.fill': 'fast_rewind',
  'pause.fill': 'pause', 'play.fill': 'play_arrow', 'forward.end.fill': 'skip_next',
  'backward.end.fill': 'skip_previous', 'heart': 'favorite_border', 'heart.fill': 'favorite',
  'headphones': 'headphones', 'hifispeaker.fill': 'speaker', 'iphone': 'smartphone',
  'laptopcomputer': 'laptop_mac', 'infinity': 'all_inclusive', 'line.3.horizontal': 'drag_handle',
  'list.bullet': 'format_list_bulleted', 'magnifyingglass': 'search', 'music.note': 'music_note',
  'plus': 'add', 'repeat': 'repeat', 'repeat.1': 'repeat_one', 'shuffle': 'shuffle',
  'speaker.fill': 'volume_mute', 'speaker.wave.3.fill': 'volume_up', 'speaker.wave.2.fill': 'volume_up',
  'square.and.arrow.up': 'ios_share', 'text.badge.plus': 'playlist_add', 'text.insert': 'playlist_play',
  'text.line.first.and.arrowtriangle.forward': 'playlist_play', 'trash': 'delete',
  'quote.bubble': 'format_quote', 'waveform': 'graphic_eq', 'xmark': 'close', 'xmark.circle.fill': 'cancel',
  'square.grid.2x2': 'grid_view', 'person.crop.circle': 'account_circle', 'person.crop.circle.fill': 'account_circle',
  'person.crop.circle.badge.plus': 'person_add', 'server.rack': 'dns', 'arrow.left.arrow.right': 'swap_horiz',
  'rectangle.portrait.and.arrow.right': 'logout', 'safari': 'open_in_browser', 'ticket': 'confirmation_number', 'music.note.list': 'library_music', 'music.note.house': 'home',
};

export function Icon({ name, size = 22, color, style }: {
  name: string;
  size?: number;
  color?: ColorValue;
  style?: StyleProp<ViewStyle>;
}) {
  const colors = useColors();
  const alternate = material[name] ?? 'music_note';
  return <SymbolView
    name={{ ios: name as AppleSymbol, android: alternate, web: alternate }}
    style={[{ width: size, height: size }, style]}
    accessibilityElementsHidden
    importantForAccessibility="no"
    size={size}
    tintColor={color ?? colors.text}
    weight="medium"
    resizeMode="scaleAspectFit"
  />;
}

export function Cover({ source, size, style, radius = 10 }: {
  source: ImageSource | number | string;
  size?: number;
  style?: ComponentProps<typeof Image>['style'];
  radius?: number;
}) {
  const colors = useColors();
  return <Image
    source={source}
    contentFit="cover"
    cachePolicy="memory-disk"
    style={[{ width: size, height: size, borderRadius: radius, backgroundColor: colors.surface }, style]}
  />;
}
