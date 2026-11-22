import {
  Button, Form, Host, HStack, ProgressView, Section, Spacer, Text, TextField, VStack, useNativeState,
} from '@expo/ui/swift-ui';
import {
  accessibilityLabel, autocorrectionDisabled, disabled, font, foregroundStyle, listRowBackground,
  listRowInsets, scrollContentBackground, scrollDismissesKeyboard, submitLabel, textInputAutocapitalization, tint,
} from '@expo/ui/swift-ui/modifiers';
import type { ScrobbleService } from '@squirmy/contracts';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { KeyboardAvoidingView, StyleSheet } from 'react-native';
import { closeSheet } from '../closeSheet';
import { SheetFormHeader, SheetPickerRow } from '../SheetUI';
import { StorageSection } from '../streamingCache/StorageSection';
import { useColors } from '../theme';
import {
  lastFmAdminNote, lastFmNote, normalizationNote, normalizationOptions, openListenBrainzSettings, qualityNote, qualityOptions,
  scrobbleDetail, useSettingsScreen,
} from './settings';

const clearRow = [listRowBackground('clear'), listRowInsets({ top: 0, leading: 0, bottom: 0, trailing: 0 })];

export function SettingsScreen() {
  const colors = useColors();
  const router = useRouter();
  const screen = useSettingsScreen();
  const { settings, update } = screen;
  const lastFm = screen.lastFm;

  return <KeyboardAvoidingView behavior="padding" style={styles.page}>
    <Host style={styles.page}>
      <VStack spacing={0}>
        <SheetFormHeader title="Settings" onClose={() => closeSheet(router)} />
        {/* Clear, so the sheet's own background shows behind the header and the form alike. */}
        <Form modifiers={[scrollDismissesKeyboard('interactively'), scrollContentBackground('hidden'), tint(colors.accent)]}>
        {settings ? <>
          <Section title="Playback" footer={<Text>{normalizationNote}</Text>}>
            <SheetPickerRow label="Normalize Volume" value={settings.normalization} options={normalizationOptions}
              onChange={normalization => update({ normalization })} />
          </Section>
          <Section title="Streaming Quality" footer={<Text>{qualityNote}</Text>}>
            <SheetPickerRow label="Wi-Fi" value={settings.qualityWifi} options={qualityOptions} onChange={qualityWifi => update({ qualityWifi })} />
            <SheetPickerRow label="Cellular" value={settings.qualityCellular} options={qualityOptions}
              onChange={qualityCellular => update({ qualityCellular })} />
          </Section>
        </> : <Section modifiers={clearRow}><HStack><Spacer /><ProgressView /><Spacer /></HStack></Section>}
        <StorageSection />
        {screen.listenBrainz && <ListenBrainzSection service={screen.listenBrainz} busy={screen.connectingListenBrainz}
          onConnect={screen.connectListenBrainz} onDisconnect={() => screen.disconnect('listenbrainz')} />}
        {/* Without the server's Last.fm key there is nothing to connect; only an admin can add one. */}
        {lastFm?.available && <Section title="Last.fm" footer={<Text>{lastFmNote}</Text>}>
          <ServiceStatus service={lastFm} />
          {lastFm.connected && !lastFm.needsAttention
            ? <Button label="Disconnect" role="destructive" onPress={() => screen.disconnect('lastfm')} />
            : <Button label={lastFm.connected ? 'Connect Again' : 'Connect'} onPress={screen.connectLastFm}
              modifiers={[tint(colors.accent)]} />}
        </Section>}
        {lastFm && !lastFm.available && screen.isAdmin && <Section footer={<Text>{lastFmAdminNote}</Text>}>{null}</Section>}
        </Form>
      </VStack>
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
      <Button label="Get Your Token" systemImage="arrow.up.forward.square" onPress={openListenBrainzSettings} modifiers={[tint(colors.accent)]} />
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
