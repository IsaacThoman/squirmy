import type { ScrobbleService } from '@squirmy/contracts';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { closeSheet } from '../closeSheet';
import { useEqualizerAvailable, useNormalizationBoosts } from '../playback';
import {
  automaticPreamp, clampGain, customEqualizerNote, equalizerBands, equalizerNote, equalizerOptions, equalizerRangeDb, formatGain,
  maxPreampDb, type EqualizerSetting,
} from '../player/engine/equalizer';
import { useEqualizerSetting } from '../player/engine/output';
import { SheetFrame, SheetRow, SheetRows } from '../SheetUI';
import { StorageSection } from '../streamingCache/StorageSection';
import { createThemedStyles, useColors } from '../theme';
import {
  explicitLabel, explicitNote, explicitRestrictedNote, lastFmAdminNote, normalizationNote, normalizationOptions, normalizationTarget,
  openListenBrainzSettings, qualityNote, qualityOptions, ratingsLabel, ratingsNote, scrobbleDetail, scrobbleFooter, serverMusicLabel, serverMusicNote, shareNowPlayingLabel,
  shareNowPlayingNote, targetOptions, useSettingsScreen,
} from './settings';

export function SettingsScreen() {
  const styles = useStyles();
  const router = useRouter();
  const screen = useSettingsScreen();
  const { settings, update } = screen;
  const boosts = useNormalizationBoosts();
  const equalizerAvailable = useEqualizerAvailable();
  const [equalizer, setEqualizer] = useEqualizerSetting();
  return <ScrollView keyboardShouldPersistTaps="handled">
    <SheetFrame title="Settings" onClose={() => closeSheet(router)}>
      {settings ? <>
        <Text style={styles.heading}>Volume normalization</Text>
        <SheetRows>
          {normalizationOptions.map(option => <SheetRow key={option.value} title={option.label} icon="speaker.wave.2.fill"
            selected={settings.normalization === option.value} onPress={() => update({ normalization: option.value })} />)}
        </SheetRows>
        {settings.normalization !== 'off' && <>
          <Text style={styles.heading}>Target loudness</Text>
          <SheetRows>
            {targetOptions.map(option => <SheetRow key={option.value} title={option.label} icon="speaker.wave.3.fill"
              selected={normalizationTarget(settings) === option.value} onPress={() => update({ normalizationTarget: option.value })} />)}
          </SheetRows>
        </>}
        <Text style={styles.note}>{normalizationNote(boosts)}</Text>
        {equalizerAvailable && <>
          <Text style={styles.heading}>Equalizer</Text>
          <SheetRows>
            {equalizerOptions.map(option => <SheetRow key={option.value} title={option.label} icon="slider.vertical.3"
              selected={equalizer.preset === option.value} onPress={() => setEqualizer({ ...equalizer, preset: option.value })} />)}
          </SheetRows>
          {equalizer.preset === 'custom' && <CustomEqualizer setting={equalizer} onChange={setEqualizer} />}
          <Text style={styles.note}>{equalizer.preset === 'custom' ? `${equalizerNote} ${customEqualizerNote}` : equalizerNote}</Text>
        </>}
        <Text style={styles.heading}>Wi-Fi quality</Text>
        <SheetRows>
          {qualityOptions.map(option => <SheetRow key={option.value} title={option.label} icon="wifi"
            selected={settings.qualityWifi === option.value} onPress={() => update({ qualityWifi: option.value })} />)}
        </SheetRows>
        <Text style={styles.heading}>Cellular quality</Text>
        <SheetRows>
          {qualityOptions.map(option => <SheetRow key={option.value} title={option.label} icon="antenna.radiowaves.left.and.right"
            selected={settings.qualityCellular === option.value} onPress={() => update({ qualityCellular: option.value })} />)}
        </SheetRows>
        <Text style={styles.note}>{qualityNote}</Text>
        {screen.errors.playback && <Text style={[styles.note, styles.error]}>{screen.errors.playback}</Text>}
        <Text style={styles.heading}>Library</Text>
        <SheetRows>
          <SheetRow title={serverMusicLabel} icon="square.stack" selected={settings.libraryIncludesServerMusic}
            onPress={() => screen.setLibraryIncludesServerMusic(!settings.libraryIncludesServerMusic)} />
        </SheetRows>
        <Text style={styles.note}>{serverMusicNote}</Text>
        <SheetRows>
          <SheetRow title={ratingsLabel} icon="star" selected={settings.showRatings ?? false}
            onPress={() => screen.setShowRatings(!settings.showRatings)} />
        </SheetRows>
        <Text style={styles.note}>{ratingsNote}</Text>
        <SheetRows>
          {/* Shown off and inert while an admin keeps explicit content off for the account. */}
          <SheetRow title={explicitLabel} icon="e.square.fill" selected={screen.allowExplicit}
            onPress={() => { if (!screen.explicitRestricted) screen.setAllowExplicit(!screen.allowExplicit); }} />
        </SheetRows>
        <Text style={styles.note}>{screen.explicitRestricted ? explicitRestrictedNote : explicitNote}</Text>
        {screen.errors.library && <Text style={[styles.note, styles.error]}>{screen.errors.library}</Text>}
      </> : screen.settingsFailure ? <SheetRows>
        <SheetRow title="Couldn’t load your settings" subtitle={screen.settingsFailure.description} icon="exclamationmark.circle"
          onPress={screen.settingsFailure.retry ?? (() => {})} />
      </SheetRows> : <ActivityIndicator />}
      <StorageSection />
      {settings && <>
        <Text style={styles.heading}>Privacy</Text>
        <SheetRows>
          <SheetRow title={shareNowPlayingLabel} icon="eye" selected={settings.shareNowPlaying ?? false}
            onPress={() => screen.setShareNowPlaying(!settings.shareNowPlaying)} />
        </SheetRows>
        <Text style={styles.note}>{shareNowPlayingNote}</Text>
        {screen.errors.privacy && <Text style={[styles.note, styles.error]}>{screen.errors.privacy}</Text>}
      </>}
      {screen.listenBrainz && <ListenBrainz service={screen.listenBrainz} busy={screen.connectingListenBrainz}
        error={screen.errors.listenbrainz} onConnect={screen.connectListenBrainz} onDisconnect={() => screen.disconnect('listenbrainz')} />}
      {screen.listenBrainz?.connected && <ScrobbleSwitch service={screen.listenBrainz} enabled={screen.scrobbleEnabled(screen.listenBrainz)}
        onToggle={enabled => screen.setScrobbling('listenbrainz', enabled)} />}
      {screen.lastFm && !screen.lastFm.available && screen.isAdmin && <Text style={styles.note}>{lastFmAdminNote}</Text>}
      {screen.lastFm?.available && <>
        <Text style={styles.heading}>Last.fm</Text>
        <SheetRows>
          <SheetRow title={screen.lastFm.connected && !screen.lastFm.needsAttention ? 'Disconnect' : 'Connect'}
            subtitle={scrobbleDetail(screen.lastFm)} icon="music.note"
            onPress={() => screen.lastFm?.connected && !screen.lastFm.needsAttention ? screen.disconnect('lastfm') : screen.connectLastFm()} />
        </SheetRows>
        {screen.lastFm.connected && <ScrobbleSwitch service={screen.lastFm} enabled={screen.scrobbleEnabled(screen.lastFm)}
          onToggle={enabled => screen.setScrobbling('lastfm', enabled)} />}
        {screen.errors.lastfm && <Text style={[styles.note, styles.error]}>{screen.errors.lastfm}</Text>}
      </>}
    </SheetFrame>
  </ScrollView>;
}

/** The custom curve, a band to a row, each turned up or down a decibel at a time. Each change plays at once. */
function CustomEqualizer({ setting, onChange }: { setting: EqualizerSetting; onChange: (setting: EqualizerSetting) => void }) {
  const styles = useStyles();
  const { bandsDb, preampDb } = setting.custom;
  const change = (custom: Partial<EqualizerSetting['custom']>) => onChange({ ...setting, custom: { ...setting.custom, ...custom } });
  const automatic = automaticPreamp(bandsDb);
  return <View style={styles.bands}>
    {equalizerBands.map((band, index) => <GainStepper key={band.label} label={band.label} spoken={band.spoken} value={bandsDb[index]}
      min={-equalizerRangeDb} max={equalizerRangeDb}
      onChange={gain => change({ bandsDb: bandsDb.map((old, at) => at === index ? clampGain(gain) : old) })} />)}
    <GainStepper label="Preamp" spoken="Preamp" value={preampDb ?? automatic} min={-equalizerRangeDb} max={maxPreampDb}
      shown={preampDb === null ? `Auto ${formatGain(automatic)}` : undefined} onChange={gain => change({ preampDb: clampGain(gain) })} />
    <SheetRows>
      {preampDb !== null && <SheetRow title="Automatic preamp" icon="wand.and.stars" onPress={() => change({ preampDb: null })} />}
      <SheetRow title="Reset" icon="arrow.counterclockwise" onPress={() => change({ bandsDb: bandsDb.map(() => 0), preampDb: null })} />
    </SheetRows>
  </View>;
}

function GainStepper({ label, spoken, value, min, max, shown, onChange }: {
  label: string; spoken: string; value: number; min: number; max: number; shown?: string; onChange: (value: number) => void;
}) {
  const styles = useStyles();
  const text = shown ?? formatGain(value);
  return <View style={styles.band} accessible accessibilityRole="adjustable" accessibilityLabel={spoken} accessibilityValue={{ text }}
    accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
    onAccessibilityAction={event => onChange(Math.max(min, Math.min(max, value + (event.nativeEvent.actionName === 'increment' ? 1 : -1))))}>
    <Text style={styles.bandLabel}>{label}</Text>
    <Pressable accessibilityElementsHidden importantForAccessibility="no" disabled={value <= min} onPress={() => onChange(Math.max(min, value - 1))}
      style={styles.step}><Text style={styles.stepText}>−</Text></Pressable>
    <Text style={styles.bandValue}>{text}</Text>
    <Pressable accessibilityElementsHidden importantForAccessibility="no" disabled={value >= max} onPress={() => onChange(Math.min(max, value + 1))}
      style={styles.step}><Text style={styles.stepText}>+</Text></Pressable>
  </View>;
}

/** A connected service's switch, as on the web: off, plays are kept from the service without disconnecting it. */
function ScrobbleSwitch({ service, enabled, onToggle }: { service: ScrobbleService; enabled: boolean; onToggle: (enabled: boolean) => void }) {
  const styles = useStyles();
  return <>
    <SheetRows>
      <SheetRow title={enabled ? 'Turn off scrobbling' : 'Turn on scrobbling'} icon={enabled ? 'pause.circle' : 'play.circle'}
        onPress={() => onToggle(!enabled)} />
    </SheetRows>
    <Text style={styles.note}>{scrobbleFooter(service, enabled)}</Text>
  </>;
}

function ListenBrainz({ service, busy, error, onConnect, onDisconnect }: {
  service: ScrobbleService; busy: boolean; error?: string; onConnect: (token: string) => void; onDisconnect: () => void;
}) {
  const colors = useColors();
  const styles = useStyles();
  const [token, setToken] = useState('');
  const connected = service.connected && !service.needsAttention;
  return <>
    <Text style={styles.heading}>ListenBrainz</Text>
    <Text style={styles.note}>{scrobbleDetail(service)}</Text>
    {!connected && <SheetRows><SheetRow title="Get your token" subtitle="From your ListenBrainz settings page" icon="arrow.up.forward.square"
      onPress={openListenBrainzSettings} /></SheetRows>}
    {connected ? <SheetRows><SheetRow title="Disconnect" icon="xmark" onPress={onDisconnect} /></SheetRows> : <View style={styles.tokenRow}>
      <TextInput value={token} onChangeText={setToken} placeholder="User token" placeholderTextColor={colors.muted}
        autoCapitalize="none" autoCorrect={false} style={styles.input} accessibilityLabel="ListenBrainz user token" />
      <Pressable accessibilityRole="button" disabled={!token.trim() || busy} onPress={() => onConnect(token.trim())} style={styles.connect}>
        <Text style={styles.connectText}>Connect</Text>
      </Pressable>
    </View>}
    {error && <Text style={[styles.note, styles.error]}>{error}</Text>}
  </>;
}

const useStyles = createThemedStyles(colors => StyleSheet.create({
  heading: { color: colors.text, fontSize: 17, fontWeight: '700', marginTop: 6 },
  note: { color: colors.muted, fontSize: 13, lineHeight: 19 },
  error: { color: colors.danger, fontWeight: '600' },
  tokenRow: { flexDirection: 'row', gap: 8, alignItems: 'center' },
  input: { flex: 1, minHeight: 44, borderRadius: 12, paddingHorizontal: 12, backgroundColor: colors.surface, color: colors.text },
  connect: { minHeight: 44, paddingHorizontal: 14, borderRadius: 12, justifyContent: 'center', backgroundColor: colors.accent },
  connectText: { color: colors.onAccent, fontWeight: '700' },
  bands: { gap: 6 },
  band: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 44 },
  bandLabel: { color: colors.text, fontSize: 15, width: 64, fontVariant: ['tabular-nums'] },
  bandValue: { color: colors.muted, fontSize: 15, flex: 1, textAlign: 'center', fontVariant: ['tabular-nums'] },
  step: { width: 44, height: 36, borderRadius: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surface },
  stepText: { color: colors.text, fontSize: 20, fontWeight: '600' },
}));
