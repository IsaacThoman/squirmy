import {
  Button, Form, Host, HStack, ProgressView, Section, Spacer, Text, TextField, Toggle, VStack, useNativeState,
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
import { serviceNames } from './scrobbling';
import {
  lastFmAdminNote, normalizationNote, normalizationOptions, openListenBrainzSettings, qualityNote, qualityOptions,
  scrobbleDetail, scrobbleFooter, useSettingsScreen,
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
        {/* Clear, so the sheet's own background shows behind the header and the form alike. Footers and
            values take `muted`: the form's own secondary gray is about 3.2:1 on this sheet in Light. */}
        <Form modifiers={[scrollDismissesKeyboard('interactively'), scrollContentBackground('hidden'), tint(colors.accent)]}>
        {settings ? <>
          <Section title="Playback" footer={<Text modifiers={[foregroundStyle(colors.muted)]}>{normalizationNote}</Text>}>
            <SheetPickerRow label="Volume Normalization" value={settings.normalization} options={normalizationOptions}
              onChange={normalization => update({ normalization })} />
          </Section>
          <Section title="Streaming Quality" footer={<Text modifiers={[foregroundStyle(colors.muted)]}>{qualityNote}</Text>}>
            <SheetPickerRow label="Wi-Fi" value={settings.qualityWifi} options={qualityOptions} onChange={qualityWifi => update({ qualityWifi })} />
            <SheetPickerRow label="Cellular" value={settings.qualityCellular} options={qualityOptions}
              onChange={qualityCellular => update({ qualityCellular })} />
            {screen.errors.playback && <ServiceError message={screen.errors.playback} />}
          </Section>
        </> : screen.settingsFailure
          ? <LoadFailure title="Couldn’t load your settings" failure={screen.settingsFailure} />
          : <Section modifiers={clearRow}><HStack><Spacer /><ProgressView /><Spacer /></HStack></Section>}
        <StorageSection />
        {/* Settings' own failure says it already; the connections have one only when they fail alone. */}
        {screen.scrobblingFailure && !screen.settingsFailure
          && <LoadFailure title="Couldn’t load scrobbling" failure={screen.scrobblingFailure} />}
        {screen.listenBrainz && <ListenBrainzSection service={screen.listenBrainz} enabled={screen.scrobbleEnabled(screen.listenBrainz)}
          busy={screen.connectingListenBrainz} error={screen.errors.listenbrainz} onConnect={screen.connectListenBrainz}
          onToggle={enabled => screen.setScrobbling('listenbrainz', enabled)} onDisconnect={() => screen.disconnect('listenbrainz')} />}
        {/* Without the server's Last.fm key there is nothing to connect; only an admin can add one. */}
        {lastFm?.available && <Section title="Last.fm"
          footer={<Text modifiers={[foregroundStyle(colors.muted)]}>{scrobbleFooter(lastFm, screen.scrobbleEnabled(lastFm))}</Text>}>
          <ServiceStatus service={lastFm} enabled={screen.scrobbleEnabled(lastFm)} onToggle={enabled => screen.setScrobbling('lastfm', enabled)} />
          {lastFm.connected && !lastFm.needsAttention
            ? <Button label="Disconnect" role="destructive" onPress={() => screen.disconnect('lastfm')} />
            : <Button label={lastFm.connected ? 'Connect Again' : 'Connect'} onPress={screen.connectLastFm}
              modifiers={[tint(colors.accent)]} />}
          {screen.errors.lastfm && <ServiceError message={screen.errors.lastfm} />}
        </Section>}
        {lastFm && !lastFm.available && screen.isAdmin && <Section footer={<Text modifiers={[foregroundStyle(colors.muted)]}>{lastFmAdminNote}</Text>}>{null}</Section>}
        </Form>
      </VStack>
    </Host>
  </KeyboardAvoidingView>;
}

/**
 * Who a service is connected as, or what is wrong. While connected it is the service's switch,
 * as on the web: off, plays are kept from the service without disconnecting it.
 */
function ServiceStatus({ service, enabled, onToggle }: { service: ScrobbleService; enabled: boolean; onToggle: (enabled: boolean) => void }) {
  const colors = useColors();
  const warning = service.needsAttention || Boolean(service.lastError);
  const title = <Text modifiers={[font({ textStyle: 'body' })]}>Scrobbling</Text>;
  const detail = <Text modifiers={[font({ textStyle: 'footnote' }), foregroundStyle(warning ? colors.danger : colors.muted)]}>{scrobbleDetail(service)}</Text>;
  if (!service.connected) return <VStack alignment="leading" spacing={2}>{title}{detail}</VStack>;
  return <Toggle isOn={enabled} onIsOnChange={onToggle} modifiers={[tint(colors.accent), accessibilityLabel(`Scrobble to ${serviceNames[service.target]}`)]}>
    {title}
    {detail}
  </Toggle>;
}

/** A section that didn't load: why, and a way to try again when trying can help. */
function LoadFailure({ title, failure }: { title: string; failure: { description: string; retry: (() => void) | null } }) {
  const colors = useColors();
  return <Section>
    <HStack>
      <VStack alignment="leading" spacing={2}>
        <Text modifiers={[font({ textStyle: 'body' })]}>{title}</Text>
        <Text modifiers={[font({ textStyle: 'footnote' }), foregroundStyle(colors.muted)]}>{failure.description}</Text>
      </VStack>
      <Spacer />
      {failure.retry && <Button label="Try Again" onPress={failure.retry} modifiers={[tint(colors.accent)]} />}
    </HStack>
  </Section>;
}

/** A refusal, in the error color, under the control that was refused (the app has no toasts). */
function ServiceError({ message }: { message: string }) {
  const colors = useColors();
  return <Text modifiers={[font({ textStyle: 'footnote', weight: 'semibold' }), foregroundStyle(colors.danger)]}>{message}</Text>;
}

function ListenBrainzSection({ service, enabled, busy, error, onConnect, onToggle, onDisconnect }: {
  service: ScrobbleService; enabled: boolean; busy: boolean; error?: string;
  onConnect: (token: string) => void; onToggle: (enabled: boolean) => void; onDisconnect: () => void;
}) {
  const colors = useColors();
  const [token, setToken] = useState('');
  const text = useNativeState('');
  const connected = service.connected && !service.needsAttention;
  return <Section title="ListenBrainz" footer={<Text modifiers={[foregroundStyle(colors.muted)]}>{scrobbleFooter(service, enabled)}</Text>}>
    <ServiceStatus service={service} enabled={enabled} onToggle={onToggle} />
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
    {error && <ServiceError message={error} />}
  </Section>;
}

const styles = StyleSheet.create({
  page: { flex: 1 },
});
