import { Image } from 'expo-image';
import { StyleSheet, View } from 'react-native';
import type { QueueEntry } from '@squirmy/contracts';
import { useArtworkImage } from '../data/artwork';
import { useTrack } from '../data/library';
import { usePlaybackState } from '../playback';
import { upcomingArtworkEntries } from './artwork';

/**
 * Loads the artwork of the songs either side of this one into the image cache's memory, decoded,
 * so a skip shows it sharp at once. The images are laid out as large as Now Playing's but never
 * drawn.
 */
export function ArtworkPrefetch({ size }: { size: number }) {
  const { queue } = usePlaybackState();
  const entries = upcomingArtworkEntries(queue);
  return <View pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={styles.hidden}>
    {entries.map(entry => <Upcoming key={entry.id} entry={entry} size={size} />)}
  </View>;
}

function Upcoming({ entry, size }: { entry: QueueEntry; size: number }) {
  const track = useTrack(entry.trackId, entry.albumId);
  const image = useArtworkImage(track?.album?.artwork, 440);
  return image ? <Image source={image.source} cachePolicy="memory-disk" allowDownscaling={false}
    style={[styles.image, { width: size, height: size }]} /> : null;
}

const styles = StyleSheet.create({
  hidden: { position: 'absolute', top: 0, left: 0, opacity: 0 },
  image: { position: 'absolute', top: 0, left: 0 },
});
