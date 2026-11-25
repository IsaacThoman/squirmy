import { ActionSheetIOS, Alert, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { displayFontScale, secondaryFontScale } from '../fontScale';
import { createThemedStyles } from '../theme';

/** `artistLinks` makes the artist line open those artists' pages: one directly, several from a choice. */
export type AlbumMetadataProps = { title: string; info: string; artist?: string; artistLinks?: readonly { name: string; open: () => void }[] };

const noArtistLinks: NonNullable<AlbumMetadataProps['artistLinks']> = [];

/**
 * The title block of a detail page: title, artist, and a line of facts. It is React Native
 * text rather than SwiftUI so the page lays out with its real height, even mid-bounce.
 */
export function AlbumMetadata({ title, info, artist, artistLinks = noArtistLinks }: AlbumMetadataProps) {
  const styles = useStyles();
  const openArtist = () => {
    if (artistLinks.length === 1) {
      artistLinks[0].open();
    } else if (Platform.OS === 'ios') {
      ActionSheetIOS.showActionSheetWithOptions({
        options: [...artistLinks.map(link => link.name), 'Cancel'], cancelButtonIndex: artistLinks.length,
      }, index => artistLinks[index]?.open());
    } else {
      Alert.alert(artist ?? '', undefined, [
        ...artistLinks.map(link => ({ text: link.name, onPress: link.open })),
        { text: 'Cancel', style: 'cancel' as const },
      ]);
    }
  };
  return <View style={styles.metadata}>
    <Text accessibilityRole="header" maxFontSizeMultiplier={displayFontScale} style={styles.title}>{title}</Text>
    {artist && (artistLinks.length
      ? <Pressable accessibilityRole="link" onPress={openArtist} hitSlop={8} style={({ pressed }) => pressed && styles.pressed}>
        <Text maxFontSizeMultiplier={secondaryFontScale} style={[styles.artist, styles.artistLink]}>{artist}</Text>
      </Pressable>
      : <Text maxFontSizeMultiplier={secondaryFontScale} style={styles.artist}>{artist}</Text>)}
    <Text maxFontSizeMultiplier={secondaryFontScale} style={styles.info}>{info}</Text>
  </View>;
}

// Sizes of the iOS large title, title 3 and footnote styles.
const useStyles = createThemedStyles(colors => StyleSheet.create({
  metadata: { alignSelf: 'stretch', alignItems: 'center', gap: 4 },
  title: { color: colors.text, fontSize: 34, lineHeight: 41, fontWeight: '600', textAlign: 'center' },
  artist: { color: colors.text, fontSize: 20, lineHeight: 25, fontWeight: '500', textAlign: 'center' },
  artistLink: { color: colors.accent, fontWeight: '600' },
  info: { color: colors.muted, fontSize: 13, lineHeight: 18, fontVariant: ['tabular-nums'], textAlign: 'center' },
  pressed: { opacity: 0.6 },
}));
