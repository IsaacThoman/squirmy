import type { Artwork } from '@squirmy/contracts';
import { Image } from 'expo-image';
import { SymbolView, type AndroidSymbol } from 'expo-symbols';
import { useState, type ComponentProps } from 'react';
import { StyleSheet, View, type ColorValue, type StyleProp, type ViewStyle } from 'react-native';
import { useArtworkImage } from './data/artwork';
import { useColors } from './theme';

type AppleSymbol = Extract<ComponentProps<typeof SymbolView>['name'], string>;

const material: Record<string, AndroidSymbol> = {
  'laptopcomputer.and.iphone': 'devices', 'arrow.down': 'arrow_downward', 'arrow.up.arrow.down': 'swap_vert',
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
  'heart.slash': 'heart_broken', 'dot.radiowaves.left.and.right': 'radio', 'star': 'star_border', 'star.fill': 'star',
  'square.stack': 'album', 'music.mic': 'mic', 'minus.circle': 'remove_circle_outline', 'gearshape': 'settings',
  'wifi': 'wifi', 'wifi.exclamationmark': 'wifi_off', 'antenna.radiowaves.left.and.right': 'signal_cellular_alt',
  'arrow.down.circle': 'download', 'arrow.down.circle.fill': 'download_done', 'arrow.down.circle.dotted': 'downloading',
  'wifi.slash': 'wifi_off', 'exclamationmark.circle': 'error', 'arrow.clockwise': 'refresh', 'xmark.circle': 'cancel',
  'internaldrive': 'storage', 'icloud.and.arrow.down': 'cloud_download',
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

/** Artwork from the server, its placeholder while it loads, or a note on the surface color without any. */
export function Cover({ artwork, size, style, radius = 10, icon = 'music.note' }: {
  artwork: Artwork | null | undefined;
  size: number;
  style?: ComponentProps<typeof Image>['style'];
  radius?: number;
  icon?: string;
}) {
  const colors = useColors();
  const image = useArtworkImage(artwork, size);
  // A cover the server cannot deliver (its source is gone) gets the placeholder, not an empty frame.
  const [failed, setFailed] = useState<string | null>(null);
  const frame = { width: size, height: size, borderRadius: radius, backgroundColor: colors.surface };
  if (!image || failed === image.source.uri) {
    return <View style={[frame, styles.empty, style as StyleProp<ViewStyle>]}>
      <Icon name={icon} size={Math.max(14, size * 0.34)} color={colors.quiet} />
    </View>;
  }
  return <Image
    source={image.source}
    placeholder={image.placeholder}
    placeholderContentFit="cover"
    contentFit="cover"
    cachePolicy="memory-disk"
    recyclingKey={artwork?.id}
    transition={120}
    onError={() => setFailed(image.source.uri ?? null)}
    style={[frame, style]}
  />;
}

const styles = StyleSheet.create({ empty: { alignItems: 'center', justifyContent: 'center', overflow: 'hidden' } });
