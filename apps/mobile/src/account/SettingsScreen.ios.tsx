import {
  Button, Form, Host, HStack, ProgressView, Section, Slider, Spacer, Text, TextField, Toggle, VStack, useNativeState,
} from '@expo/ui/swift-ui';
import {
  accessibilityLabel, accessibilityValue, autocorrectionDisabled, disabled, font, foregroundStyle, frame, listRowBackground,
  listRowInsets, monospacedDigit, scrollContentBackground, scrollDismissesKeyboard, submitLabel, textInputAutocapitalization, tint,
} from '@expo/ui/swift-ui/modifiers';
import type { ScrobbleService } from '@squirmy/contracts';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { KeyboardAvoidingView, StyleSheet } from 'react-native';
import { closeSheet } from '../closeSheet';
import { runningEngine } from '../player/engine';
import { useEqualizerAvailable, useNormalizationBoosts } from '../playback';
import {
  automaticPreamp, clampGain, customEqualizerNote, equalizerBands, equalizerNote, equalizerOptions, equalizerRangeDb, formatGain,
  maxPreampDb, type EqualizerSetting,
} from '../player/engine/equalizer';
import { useEqualizerSetting } from '../player/engine/output';
import { engineNote, engineOptions, showsEngineSetting, useEngineSetting } from '../player/engine/setting';
import { SheetFormHeader, SheetPickerRow } from '../SheetUI';
import { StorageSection } from '../streamingCache/StorageSection';
import { useColors } from '../theme';
import { serviceNames } from './scrobbling';
import {
  explicitLabel, explicitNote, explicitRestrictedNote, lastFmAdminNote, nativeQualityNote, normalizationNote, normalizationOptions, normalizationTarget,
  openListenBrainzSettings, qualityNote, qualityOptions, ratingsLabel, ratingsNote, scrobbleDetail, scrobbleFooter, serverMusicLabel, serverMusicNote, shareNowPlayingLabel,
  shareNowPlayingNote, targetOptions, useSettingsScreen,
} from './settings';

const clearRow = [listRowBackground('clear'), listRowInsets({ top: 0, leading: 0, bottom: 0, trailing: 0 })];

export function SettingsScreen() {
  const colors = useColors();
  const router = useRouter();
  const screen = useSettingsScreen();
  const { settings, update } = screen;
  const lastFm = screen.lastFm;
  const [engine, setEngine] = useEngineSetting();
  const engineChoice = showsEngineSetting();
  const equalizerAvailable = useEqualizerAvailable();
  const [equalizer, setEqualizer] = useEqualizerSetting();
  const playbackNote = [normalizationNote(useNormalizationBoosts()), equalizerAvailable ? equalizerNote : null, engineChoice ? engineNote : null]
    .filter(Boolean).join('\n\n');

  return <KeyboardAvoidingView behavior="padding" style={styles.page}>
    <Host style={styles.page}>
      <VStack spacing={0}>
        <SheetFormHeader title="Settings" onClose={() => closeSheet(router)} />
        {/* Clear, so the sheet's own background shows behind the header and the form alike. Footers and
            values take `muted`: the form's own secondary gray is about 3.2:1 on this sheet in Light. */}
        <Form modifiers={[scrollDismissesKeyboard('interactively'), scrollContentBackground('hidden'), tint(colors.accent)]}>
        {settings ? <>
          <Section title="Playback" footer={<Text modifiers={[foregroundStyle(colors.muted)]}>{playbackNote}</Text>}>
            <SheetPickerRow label="Volume Normalization" value={settings.normalization} options={normalizationOptions}
              onChange={normalization => update({ normalization })} />
            {/* Only normalization has a target: with it off, songs play as they are. */}
            {settings.normalization !== 'off' && <SheetPickerRow label="Target Loudness" value={normalizationTarget(settings)} options={targetOptions}
              onChange={target => update({ normalizationTarget: target })} />}
            {/* The device's own, so it changes at once and needs no account settings. */}
            {equalizerAvailable && <SheetPickerRow label="Equalizer" value={equalizer.preset} options={equalizerOptions}
              onChange={preset => setEqualizer({ ...equalizer, preset })} />}
            {engineChoice && <SheetPickerRow label="Engine" value={engine} options={engineOptions} onChange={setEngine} />}
          </Section>
          {equalizerAvailable && equalizer.preset === 'custom' && <CustomEqualizer setting={equalizer} onChange={setEqualizer} />}
          <Section title="Streaming Quality" footer={<Text modifiers={[foregroundStyle(colors.muted)]}>{runningEngine() === 'native' ? nativeQualityNote : qualityNote}</Text>}>
            <SheetPickerRow label="Wi-Fi" value={settings.qualityWifi} options={qualityOptions} onChange={qualityWifi => update({ qualityWifi })} />
            <SheetPickerRow label="Cellular" value={settings.qualityCellular} options={qualityOptions}
              onChange={qualityCellular => update({ qualityCellular })} />
            {screen.errors.playback && <ServiceError message={screen.errors.playback} />}
          </Section>
          <Section title="Library" footer={<Text modifiers={[foregroundStyle(colors.muted)]}>{serverMusicNote}</Text>}>
            <Toggle isOn={settings.libraryIncludesServerMusic} onIsOnChange={screen.setLibraryIncludesServerMusic} modifiers={[tint(colors.accent)]}>
              <Text modifiers={[font({ textStyle: 'body' })]}>{serverMusicLabel}</Text>
            </Toggle>
            {screen.errors.library && <ServiceError message={screen.errors.library} />}
          </Section>
          <Section footer={<Text modifiers={[foregroundStyle(colors.muted)]}>{ratingsNote}</Text>}>
            <Toggle isOn={settings.showRatings ?? false} onIsOnChange={screen.setShowRatings} modifiers={[tint(colors.accent)]}>
              <Text modifiers={[font({ textStyle: 'body' })]}>{ratingsLabel}</Text>
            </Toggle>
          </Section>
          <Section title="Explicit Content" footer={<Text modifiers={[foregroundStyle(colors.muted)]}>{screen.explicitRestricted ? explicitRestrictedNote : explicitNote}</Text>}>
            <Toggle isOn={screen.allowExplicit} onIsOnChange={screen.setAllowExplicit} modifiers={[tint(colors.accent), disabled(screen.explicitRestricted)]}>
              <Text modifiers={[font({ textStyle: 'body' })]}>{explicitLabel}</Text>
            </Toggle>
          </Section>
        </> : screen.settingsFailure
          ? <LoadFailure title="Couldn’t load your settings" failure={screen.settingsFailure} />
          : <Section modifiers={clearRow}><HStack><Spacer /><ProgressView /><Spacer /></HStack></Section>}
        <StorageSection />
        {settings && <Section title="Privacy" footer={<Text modifiers={[foregroundStyle(colors.muted)]}>{shareNowPlayingNote}</Text>}>
          <Toggle isOn={settings.shareNowPlaying ?? false} onIsOnChange={screen.setShareNowPlaying} modifiers={[tint(colors.accent)]}>
            <Text modifiers={[font({ textStyle: 'body' })]}>{shareNowPlayingLabel}</Text>
          </Toggle>
          {screen.errors.privacy && <ServiceError message={screen.errors.privacy} />}
        </Section>}
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
 * The custom curve: a slider for each band, as the system's own audio settings have them, and
 * the preamp, automatic until it is moved. Each move plays at once.
 */
function CustomEqualizer({ setting, onChange }: { setting: EqualizerSetting; onChange: (setting: EqualizerSetting) => void }) {
  const colors = useColors();
  const { bandsDb, preampDb } = setting.custom;
  const change = (custom: Partial<EqualizerSetting['custom']>) => onChange({ ...setting, custom: { ...setting.custom, ...custom } });
  const automatic = automaticPreamp(bandsDb);
  const untouched = preampDb === null && bandsDb.every(gain => gain === 0);
  return <Section title="Custom Equalizer" footer={<Text modifiers={[foregroundStyle(colors.muted)]}>{customEqualizerNote}</Text>}>
    {equalizerBands.map((band, index) => <GainSlider key={band.label} label={band.label} spoken={band.spoken}
      value={bandsDb[index]} min={-equalizerRangeDb} max={equalizerRangeDb}
      onChange={gain => change({ bandsDb: bandsDb.map((old, at) => at === index ? clampGain(gain) : old) })} />)}
    <GainSlider label="Preamp" spoken="Preamp" value={preampDb ?? automatic} min={-equalizerRangeDb} max={maxPreampDb}
      note={preampDb === null ? 'Automatic' : undefined}
      onChange={gain => change({ preampDb: Math.min(maxPreampDb, clampGain(gain)) })} />
    {preampDb !== null && <Button label="Automatic Preamp" onPress={() => change({ preampDb: null })} modifiers={[tint(colors.accent)]} />}
    <Button label="Reset" onPress={() => change({ bandsDb: bandsDb.map(() => 0), preampDb: null })}
      modifiers={[tint(colors.accent), disabled(untouched)]} />
  </Section>;
}

/**
 * One band's slider, with its frequency on the left and its gain on the right, in half
 * decibels; `note` goes under the label (the preamp's "Automatic"), so every slider is as wide.
 */
function GainSlider({ label, spoken, value, min, max, note, onChange }: {
  label: string; spoken: string; value: number; min: number; max: number; note?: string; onChange: (value: number) => void;
}) {
  const colors = useColors();
  const text = formatGain(value);
  return <HStack spacing={10}>
    <VStack alignment="leading" spacing={1} modifiers={[frame({ width: 66, alignment: 'leading' })]}>
      <Text modifiers={[font({ textStyle: 'subheadline' }), monospacedDigit()]}>{label}</Text>
      {note && <Text modifiers={[font({ textStyle: 'caption' }), foregroundStyle(colors.muted)]}>{note}</Text>}
    </VStack>
    <Slider value={value} min={min} max={max} step={0.5} onValueChange={onChange}
      modifiers={[tint(colors.accent), accessibilityLabel(spoken), accessibilityValue(`${note ? `${note}, ` : ''}${text.replace('−', 'minus ')}`)]} />
    <Text modifiers={[font({ textStyle: 'subheadline' }), monospacedDigit(), foregroundStyle(colors.muted), frame({ width: 62, alignment: 'trailing' })]}>
      {text}
    </Text>
  </HStack>;
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
