import {
  Button, Form, Host, HStack, LabeledContent, List, RNHostView, Section, Spacer, Text, Toggle, VStack,
} from '@expo/ui/swift-ui';
import {
  accessibilityLabel, font, foregroundStyle, lineLimit, scrollContentBackground, tint,
} from '@expo/ui/swift-ui/modifiers';
import { useRouter } from 'expo-router';
import { StyleSheet, View } from 'react-native';
import { closeSheet } from '../closeSheet';
import { CollectionCover } from '../library/shared';
import { hitShape, plainButton } from '../native/Controls';
import { SheetFormHeader, SheetPickerRow } from '../SheetUI';
import { useColors } from '../theme';
import {
  capNote, capOptions, downloadQualityNote, downloadQualityOptions, useDownloadsScreen, wifiNote, type DownloadItem,
} from './screen';

const coverSize = 44;
// No limit is 0 here: a menu's values are plain numbers.
const capChoices = capOptions.map(option => ({ value: option.value ?? 0, label: option.label }));

export function DownloadsScreen() {
  const colors = useColors();
  const router = useRouter();
  const screen = useDownloadsScreen();
  const { settings, summary } = screen;
  // Opened over the account sheet: both close before the page opens beneath.
  const open = (item: DownloadItem) => {
    if (!item.href) return;
    router.dismissAll();
    router.navigate(item.href);
  };
  const empty = summary && !summary.collections.length;
  const value = foregroundStyle(colors.muted);

  return <Host style={styles.page}>
    <VStack spacing={0}>
    <SheetFormHeader title="Downloads" onClose={() => closeSheet(router)} />
    <Form modifiers={[scrollContentBackground('hidden'), tint(colors.accent)]}>
      <Section footer={empty ? <Text>Tap the download button on an album, a playlist or Liked Songs, or choose Download in a song’s menu, to keep it on this {screen.device} and play it without a connection.</Text> : undefined}>
        {/* The system's secondary color for a value is about 3:1 on these rows; the app's muted text is over 4.5:1. */}
        <LabeledContent label="Downloaded"><Text modifiers={[value]}>{empty ? 'Nothing yet' : screen.used}</Text></LabeledContent>
        <LabeledContent label={`Available on ${screen.device}`}><Text modifiers={[value]}>{screen.free}</Text></LabeledContent>
        {screen.status && <HStack>
          <Text modifiers={[foregroundStyle(screen.status.retry ? colors.danger : colors.muted)]}>{screen.status.text}</Text>
          <Spacer />
          {screen.status.retry && <Button label="Retry" onPress={screen.retry} modifiers={[tint(colors.accent)]} />}
        </HStack>}
      </Section>
      {screen.albums.length > 0 && <Items title="Albums" items={screen.albums} onOpen={open} />}
      {screen.playlists.length > 0 && <Items title="Playlists" items={screen.playlists} onOpen={open} />}
      {screen.songs.length > 0 && <Items title="Songs" items={screen.songs} onOpen={open} />}
      {settings && <>
        <Section title="Download Quality" footer={<Text>{downloadQualityNote}</Text>}>
          <SheetPickerRow label="Quality" value={settings.downloadQuality} options={downloadQualityOptions} onChange={screen.setQuality} />
        </Section>
        <Section footer={<Text>{wifiNote}</Text>}>
          <Toggle label="Wi-Fi Only" isOn={settings.downloadOnWifiOnly} onIsOnChange={screen.setWifiOnly} modifiers={[tint(colors.accent)]} />
        </Section>
      </>}
      {/* The note describes a limit, so it only shows once there is one. */}
      <Section footer={screen.cap ? <Text>{capNote}</Text> : undefined}>
        <SheetPickerRow label="Storage Limit" value={screen.cap ?? 0} options={capChoices} onChange={value => screen.setCap(value || null)} />
      </Section>
      {!empty && <Section>
        <Button label="Remove All Downloads" role="destructive" onPress={screen.removeAll} />
      </Section>}
    </Form>
    </VStack>
  </Host>;
}

/** A group of downloads; a row opens its page, a swipe removes it. */
function Items({ title, items, onOpen }: { title: string; items: readonly DownloadItem[]; onOpen: (item: DownloadItem) => void }) {
  const colors = useColors();
  return <Section title={title}>
    <List.ForEach data={items} keyExtractor={item => item.id} onDelete={indices => indices.forEach(index => items[index]?.removeNow())}>
      {({ item }) => <Button onPress={() => onOpen(item)} modifiers={[plainButton, accessibilityLabel(`${item.title}, ${item.subtitle}`)]}>
        <HStack spacing={12} modifiers={[hitShape]}>
          <RNHostView matchContents>
            <View style={{ width: coverSize, height: coverSize }}>
              <CollectionCover item={{ ...item.collection, dim: false }} size={coverSize} radius={item.collection.round ? coverSize / 2 : 8} />
            </View>
          </RNHostView>
          <VStack alignment="leading" spacing={2}>
            <Text modifiers={[font({ textStyle: 'body', weight: 'medium' }), lineLimit(1)]}>{item.title}</Text>
            <Text modifiers={[font({ textStyle: 'footnote' }), foregroundStyle(item.failed ? colors.danger : colors.muted), lineLimit(1)]}>{item.subtitle}</Text>
          </VStack>
          <Spacer minLength={4} />
        </HStack>
      </Button>}
    </List.ForEach>
  </Section>;
}

const styles = StyleSheet.create({
  page: { flex: 1 },
});
