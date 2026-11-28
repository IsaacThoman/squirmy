import type { Artwork as ArtworkInfo } from '@squirmy/contracts';
import { LinearGradient } from 'expo-linear-gradient';
import { StyleSheet, View } from 'react-native';
import { mosaicCovers } from '../../library/mosaic';
import { Icon } from '../../ui';
import { Artwork } from '../Artwork';

/** Liked Songs, history and a playlist with no covers yet have a cover of their own, as on the phone. */
const specials = {
  liked: { colors: ['#C6B4FA', '#7862B4', '#30274A'], icon: 'heart.fill' },
  recent: { colors: ['#49665F', '#324747', '#212F3B'], icon: 'clock.arrow.circlepath' },
  playlist: { colors: ['#6C5A8E', '#47395F', '#272033'], icon: 'music.note.list' },
} as const;

export type ArtKind = keyof typeof specials;

/**
 * A collection's large cover on its page: a playlist's first four covers as a mosaic, its one
 * cover, or the drawn cover of Liked Songs, history or an empty playlist.
 */
export function CollectionArt({ artworks, special = 'playlist', size, circle, radius = 20 }: {
  artworks: readonly (ArtworkInfo | null | undefined)[];
  special?: ArtKind;
  size: number;
  circle?: boolean;
  radius?: number;
}) {
  const covers = mosaicCovers(artworks.filter((artwork): artwork is ArtworkInfo => Boolean(artwork)));
  const frame = { width: size, height: size, borderRadius: circle ? size / 2 : radius };
  if (covers.length >= 4) {
    const half = size / 2;
    return <View style={[styles.mosaic, styles.shadow, frame]}>
      {covers.slice(0, 4).map(artwork => <Artwork key={artwork.id} artwork={artwork} size={half} radius={0} focusEffect={false} />)}
    </View>;
  }
  if (covers[0]) return <Artwork artwork={covers[0]} size={size} circle={circle} radius={radius} focusEffect={false} style={styles.shadow} />;
  const drawn = specials[special];
  return <LinearGradient colors={drawn.colors} start={{ x: 0.05, y: 0.05 }} end={{ x: 0.95, y: 0.95 }} style={[styles.special, frame]}>
    <View style={[styles.ring, { width: size * 0.75, height: size * 0.75, borderRadius: size }]} />
    <View style={[styles.ring, { width: size * 0.57, height: size * 0.57, borderRadius: size }]} />
    <Icon name={circle ? 'music.mic' : drawn.icon} size={Math.round(size * 0.28)} color="#FFF8FF" />
  </LinearGradient>;
}

const styles = StyleSheet.create({
  mosaic: { flexDirection: 'row', flexWrap: 'wrap', overflow: 'hidden' },
  shadow: { shadowColor: '#000', shadowOpacity: 0.35, shadowRadius: 30, shadowOffset: { width: 0, height: 20 } },
  special: { alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  ring: { position: 'absolute', borderWidth: 2, borderColor: 'rgba(255,255,255,0.12)' },
});
