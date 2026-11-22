import { useRouter } from 'expo-router';
import { Alert, Pressable, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';
import { closeSheet } from '../closeSheet';
import { CollectionCover } from '../library/shared';
import { SheetFrame, SheetRow, SheetRows } from '../SheetUI';
import { createThemedStyles, useColors } from '../theme';
import {
  capNote, capOptions, downloadQualityNote, downloadQualityOptions, useDownloadsScreen, wifiNote, type DownloadItem,
} from './screen';

export function DownloadsScreen() {
  const colors = useColors();
  const styles = useStyles();
  const router = useRouter();
  const screen = useDownloadsScreen();
  const { settings, summary } = screen;
  const empty = summary && !summary.collections.length;
  const choose = (item: DownloadItem) => Alert.alert(item.title, item.subtitle, [
    ...item.href ? [{ text: 'Open', onPress: () => {
      // Opened over the account sheet: both close before the page opens beneath.
      router.dismissAll();
      router.navigate(item.href!);
    } }] : [],
    { text: 'Remove Download', style: 'destructive', onPress: item.remove },
    { text: 'Cancel', style: 'cancel' },
  ]);
  const group = (title: string, items: readonly DownloadItem[]) => items.length > 0 && <>
    <Text style={styles.heading}>{title}</Text>
    <View style={styles.items}>
      {items.map(item => <Pressable key={item.id} accessibilityRole="button" accessibilityLabel={`${item.title}, ${item.subtitle}`}
        onPress={() => choose(item)} style={({ pressed }) => [styles.item, pressed && styles.pressed]}>
        <CollectionCover item={{ ...item.collection, dim: false }} size={44} radius={item.collection.round ? 22 : 8} />
        <View style={styles.flex}>
          <Text numberOfLines={1} style={styles.title}>{item.title}</Text>
          <Text numberOfLines={1} style={[styles.note, item.failed && { color: colors.danger }]}>{item.subtitle}</Text>
        </View>
      </Pressable>)}
    </View>
  </>;

  return <ScrollView>
    <SheetFrame title="Downloads" onClose={() => closeSheet(router)}>
      <Text style={styles.note}>{empty ? `Nothing downloaded yet. Tap the download button on an album or playlist to keep it on this ${screen.device}.`
        : `${screen.used} · ${screen.free} available`}</Text>
      {screen.status && <SheetRows>
        <SheetRow title={screen.status.text} icon={screen.status.retry ? 'exclamationmark.circle' : 'arrow.down.circle.dotted'}
          subtitle={screen.status.retry ? 'Tap to try again' : undefined} onPress={() => { if (screen.status?.retry) screen.retry(); }} />
      </SheetRows>}
      {group('Albums', screen.albums)}
      {group('Playlists', screen.playlists)}
      {group('Songs', screen.songs)}
      {settings && <>
        <Text style={styles.heading}>Download quality</Text>
        <SheetRows>
          {downloadQualityOptions.map(option => <SheetRow key={option.value} title={option.label} icon="arrow.down.circle"
            selected={settings.downloadQuality === option.value} onPress={() => screen.setQuality(option.value)} />)}
        </SheetRows>
        <Text style={styles.note}>{downloadQualityNote}</Text>
        <View style={styles.switchRow}>
          <Text style={styles.title}>Wi-Fi only</Text>
          <Switch value={settings.downloadOnWifiOnly} onValueChange={screen.setWifiOnly} trackColor={{ true: colors.accent }} />
        </View>
        <Text style={styles.note}>{wifiNote}</Text>
      </>}
      <Text style={styles.heading}>Storage limit</Text>
      <SheetRows>
        {capOptions.map(option => <SheetRow key={option.label} title={option.label} icon="internaldrive"
          selected={screen.cap === option.value} onPress={() => screen.setCap(option.value)} />)}
      </SheetRows>
      {screen.cap ? <Text style={styles.note}>{capNote}</Text> : null}
      {!empty && <SheetRows><SheetRow title="Remove all downloads" icon="trash" destructive onPress={screen.removeAll} /></SheetRows>}
    </SheetFrame>
  </ScrollView>;
}

const useStyles = createThemedStyles(colors => StyleSheet.create({
  heading: { color: colors.text, fontSize: 17, fontWeight: '700', marginTop: 6 },
  note: { color: colors.muted, fontSize: 13, lineHeight: 19 },
  items: { gap: 4 },
  item: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 6 },
  flex: { flex: 1, gap: 2 },
  title: { color: colors.text, fontSize: 15, fontWeight: '600' },
  pressed: { opacity: 0.73 },
  switchRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: 44 },
}));
