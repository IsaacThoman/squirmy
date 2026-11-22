import {
  Button, Form, Host, HStack, LabeledContent, List, Picker, RNHostView, Section, Spacer, Text, Toggle, VStack,
} from '@expo/ui/swift-ui';
import {
  accessibilityAddTraits, accessibilityLabel, font, foregroundStyle, lineLimit, listRowBackground, listRowInsets, pickerStyle, tag, tint,
} from '@expo/ui/swift-ui/modifiers';
import { useRouter } from 'expo-router';
import { StyleSheet, View } from 'react-native';
import { closeSheet } from '../closeSheet';
import { CollectionCover } from '../library/shared';
import { IconButton, hitShape, plainButton } from '../native/Controls';
import { useColors } from '../theme';
import {
  capNote, capOptions, downloadQualityNote, downloadQualityOptions, useDownloadsScreen, wifiNote, type DownloadItem,
} from './screen';

const clearRow = [listRowBackground('clear'), listRowInsets({ top: 0, leading: 0, bottom: 0, trailing: 0 })];
const coverSize = 44;

export function DownloadsScreen() {
  const colors = useColors();
  const router = useRouter();
  const screen = useDownloadsScreen();
  const { settings, summary } = screen;
  const open = (item: DownloadItem) => {
    if (!item.href) return;
    closeSheet(router);
    router.navigate(item.href);
  };
  const empty = summary && !summary.collections.length;

  return <Host style={styles.page}>
    <Form>
      <Section modifiers={clearRow}>
        <HStack>
          <Text modifiers={[font({ textStyle: 'title2', weight: 'bold' }), accessibilityAddTraits(['isHeader'])]}>Downloads</Text>
          <Spacer />
          <IconButton symbol="xmark.circle.fill" label="Close" size={26} color={colors.muted} onPress={() => closeSheet(router)} />
        </HStack>
      </Section>
      <Section footer={empty ? <Text>Tap the download button on an album or playlist to keep it on this {screen.device} and play it without a connection.</Text> : undefined}>
        <LabeledContent label="Downloaded"><Text>{empty ? 'Nothing yet' : screen.used}</Text></LabeledContent>
        <LabeledContent label={`Available on ${screen.device}`}><Text>{screen.free}</Text></LabeledContent>
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
          <Picker label="Quality" selection={settings.downloadQuality} onSelectionChange={screen.setQuality}
            modifiers={[pickerStyle('menu'), tint(colors.accent)]}>
            {downloadQualityOptions.map(option => <Text key={option.value} modifiers={[tag(option.value)]}>{option.label}</Text>)}
          </Picker>
        </Section>
        <Section footer={<Text>{wifiNote}</Text>}>
          <Toggle label="Wi-Fi Only" isOn={settings.downloadOnWifiOnly} onIsOnChange={screen.setWifiOnly} modifiers={[tint(colors.accent)]} />
        </Section>
      </>}
      <Section footer={<Text>{capNote}</Text>}>
        <Picker label="Storage Limit" selection={screen.cap ?? 0} onSelectionChange={(value: number) => screen.setCap(value || null)}
          modifiers={[pickerStyle('menu'), tint(colors.accent)]}>
          {capOptions.map(option => <Text key={option.label} modifiers={[tag(option.value ?? 0)]}>{option.label}</Text>)}
        </Picker>
      </Section>
      {!empty && <Section>
        <Button label="Remove All Downloads" role="destructive" onPress={screen.removeAll} />
      </Section>}
    </Form>
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
