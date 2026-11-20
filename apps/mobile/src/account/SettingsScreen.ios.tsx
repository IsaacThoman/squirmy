import {
  Button, Form, Host, HStack, Picker, ProgressView, Section, Spacer, Text, TextField, VStack, useNativeState,
} from '@expo/ui/swift-ui';
import {
  accessibilityAddTraits, accessibilityLabel, autocorrectionDisabled, disabled, font, foregroundStyle, listRowBackground,
  listRowInsets, pickerStyle, scrollDismissesKeyboard, submitLabel, tag, textInputAutocapitalization, tint,
} from '@expo/ui/swift-ui/modifiers';
import type { ScrobbleService } from '@squirmy/contracts';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { KeyboardAvoidingView, StyleSheet } from 'react-native';
import { closeSheet } from '../closeSheet';
import { IconButton } from '../native/Controls';
import { useColors } from '../theme';
import {
  normalizationNote, normalizationOptions, qualityNote, qualityOptions, scrobbleDetail, useSettingsScreen,
} from './settings';

const clearRow = [listRowBackground('clear'), listRowInsets({ top: 0, leading: 0, bottom: 0, trailing: 0 })];

export function SettingsScreen() {
  const colors = useColors();
  const router = useRouter();
  const screen = useSettingsScreen();
  const { settings, update } = screen;

  return <KeyboardAvoidingView behavior="padding" style={styles.page}>
    <Host style={styles.page}>
      <Form modifiers={[scrollDismissesKeyboard('interactively')]}>
        <Section modifiers={clearRow}>
          <HStack>
            <Text modifiers={[font({ textStyle: 'title2', weight: 'bold' }), accessibilityAddTraits(['isHeader'])]}>Settings</Text>
            <Spacer />
            <IconButton symbol="xmark.circle.fill" label="Close" size={26} color={colors.muted} onPress={() => closeSheet(router)} />
          </HStack>
        </Section>
        {settings ? <>
          <Section title="Playback" footer={<Text>{normalizationNote}</Text>}>
            <Picker label="Normalize Volume" selection={settings.normalization} onSelectionChange={normalization => update({ normalization })}
              modifiers={[pickerStyle('menu'), tint(colors.accent)]}>
              {normalizationOptions.map(option => <Text key={option.value} modifiers={[tag(option.value)]}>{option.label}</Text>)}
            </Picker>
          </Section>
          <Section title="Streaming Quality" footer={<Text>{qualityNote}</Text>}>
            <Picker label="Wi-Fi" selection={settings.qualityWifi} onSelectionChange={qualityWifi => update({ qualityWifi })}
              modifiers={[pickerStyle('menu'), tint(colors.accent)]}>
              {qualityOptions.map(option => <Text key={option.value} modifiers={[tag(option.value)]}>{option.label}</Text>)}
            </Picker>
            <Picker label="Cellular" selection={settings.qualityCellular} onSelectionChange={qualityCellular => update({ qualityCellular })}
              modifiers={[pickerStyle('menu'), tint(colors.accent)]}>
              {qualityOptions.map(option => <Text key={option.value} modifiers={[tag(option.value)]}>{option.label}</Text>)}
            </Picker>
          </Section>
        </> : <Section modifiers={clearRow}><HStack><Spacer /><ProgressView /><Spacer /></HStack></Section>}
        {screen.listenBrainz && <ListenBrainzSection service={screen.listenBrainz} busy={screen.connectingListenBrainz}
          onConnect={screen.connectListenBrainz} onDisconnect={() => screen.disconnect('listenbrainz')} />}
        {screen.lastFm && <Section title="Last.fm" footer={<Text>Plays are sent once you have listened to half a song or four minutes of it.</Text>}>
          <ServiceStatus service={screen.lastFm} />
          {screen.lastFm.available && (screen.lastFm.connected && !screen.lastFm.needsAttention
            ? <Button label="Disconnect" role="destructive" onPress={() => screen.disconnect('lastfm')} />
            : <Button label={screen.lastFm.connected ? 'Connect Again' : 'Connect'} onPress={screen.connectLastFm}
              modifiers={[tint(colors.accent)]} />)}
        </Section>}
      </Form>
    </Host>
  </KeyboardAvoidingView>;
}

function ServiceStatus({ service }: { service: ScrobbleService }) {
  const colors = useColors();
  const warning = service.needsAttention || Boolean(service.lastError);
  return <VStack alignment="leading" spacing={2}>
    <Text modifiers={[font({ textStyle: 'body' })]}>Scrobbling</Text>
    <Text modifiers={[font({ textStyle: 'footnote' }), foregroundStyle(warning ? colors.danger : colors.muted)]}>{scrobbleDetail(service)}</Text>
  </VStack>;
}

function ListenBrainzSection({ service, busy, onConnect, onDisconnect }: {
  service: ScrobbleService; busy: boolean; onConnect: (token: string) => void; onDisconnect: () => void;
}) {
  const colors = useColors();
  const [token, setToken] = useState('');
  const text = useNativeState('');
  const connected = service.connected && !service.needsAttention;
  return <Section title="ListenBrainz" footer={<Text>{connected
    ? 'Your plays are sent to ListenBrainz.'
    : 'Paste the user token from your ListenBrainz settings page.'}</Text>}>
    <ServiceStatus service={service} />
    {connected ? <Button label="Disconnect" role="destructive" onPress={onDisconnect} /> : <>
      <TextField text={text} onTextChange={setToken} placeholder="User token"
        modifiers={[accessibilityLabel('ListenBrainz user token'), autocorrectionDisabled(), textInputAutocapitalization('never'), submitLabel('done')]} />
      <Button onPress={() => onConnect(token.trim())} modifiers={[tint(colors.accent), disabled(!token.trim() || busy)]}>
        <HStack spacing={8}>
          <Text>Connect</Text>
          {busy && <ProgressView />}
        </HStack>
      </Button>
    </>}
  </Section>;
}

const styles = StyleSheet.create({
  page: { flex: 1 },
});
