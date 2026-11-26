import type { Artwork as ArtworkInfo } from '@squirmy/contracts';
import { Image } from 'expo-image';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { nativeTVArtwork } from '../../modules/tv-artwork';
import { useArtworkImage } from '../data/artwork';
import { Icon } from '../ui';
import { colors, tv } from './theme';

/** The native view, resolved once; null in a build without it. */
const NativeArtwork = nativeTVArtwork();

type Props = {
  artwork: ArtworkInfo | null | undefined;
  /** Width in points; covers are square unless `height` says otherwise. */
  size: number;
  height?: number;
  circle?: boolean;
  radius?: number;
  /** Lift with the focus of the `Focusable` around it. */
  focusEffect?: boolean;
  /** Shown on the placeholder of something without artwork. */
  icon?: string;
  /** Faded, for music that does not play. */
  dim?: boolean;
  /** The color behind the icon of something without artwork. */
  color?: string;
  style?: StyleProp<ViewStyle>;
};

/**
 * A cover from the server. On Apple TV it is the system's own focused image: when the
 * `Focusable` around it is focused it lifts, tilts with the remote and catches the light.
 */
export function Artwork({ artwork, size, height = size, circle = false, radius = tv.radius, focusEffect = true, icon = 'music.note', dim, color, style }: Props) {
  const image = useArtworkImage(artwork, Math.max(size, height) * 1.2);
  const uri = image?.source && typeof image.source === 'object' && 'uri' in image.source ? image.source.uri : undefined;
  const frame = { width: size, height, borderRadius: circle ? size / 2 : radius };
  const placeholderColor = artwork?.color ?? color ?? colors.placeholder;
  const empty = !uri && <View style={[StyleSheet.absoluteFill, styles.center]} pointerEvents="none">
    <Icon name={circle ? 'music.mic' : icon} size={Math.round(Math.min(size, height) * 0.32)} color={color ? '#FFF8FF' : colors.tertiary} />
  </View>;
  if (NativeArtwork) {
    return <View style={[frame, dim && styles.dim, style]}>
      <NativeArtwork style={StyleSheet.absoluteFill} uri={uri} circle={circle} cornerRadius={radius} placeholderColor={placeholderColor} focusEffect={focusEffect} />
      {empty}
    </View>;
  }
  return <View style={[frame, styles.clip, { backgroundColor: placeholderColor }, dim && styles.dim, style]}>
    {uri && <Image source={image!.source} placeholder={image!.placeholder} contentFit="cover" cachePolicy="memory-disk" transition={160}
      style={StyleSheet.absoluteFill} />}
    {empty}
  </View>;
}

const styles = StyleSheet.create({
  center: { alignItems: 'center', justifyContent: 'center' },
  clip: { overflow: 'hidden' },
  dim: { opacity: 0.4 },
});
