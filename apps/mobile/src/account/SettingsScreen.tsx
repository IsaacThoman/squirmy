import type { ScrobbleService } from '@squirmy/contracts';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { closeSheet } from '../closeSheet';
import { SheetFrame, SheetRow, SheetRows } from '../SheetUI';
import { StorageSection } from '../streamingCache/StorageSection';
import { createThemedStyles, useColors } from '../theme';
import {
  lastFmAdminNote, normalizationNote, normalizationOptions, openListenBrainzSettings, qualityNote, qualityOptions, scrobbleDetail,
  explicitLabel, explicitNote, explicitRestrictedNote, scrobbleFooter, serverMusicLabel, serverMusicNote, shareNowPlayingLabel, shareNowPlayingNote,
  useSettingsScreen,
} from './settings';

export function SettingsScreen() {
  const styles = useStyles();
  const router = useRouter();
  const screen = useSettingsScreen();
  const { settings, update } = screen;
  return <ScrollView keyboardShouldPersistTaps="handled">
    <SheetFrame title="Settings" onClose={() => closeSheet(router)}>
      {settings ? <>
        <Text style={styles.heading}>Volume normalization</Text>
        <SheetRows>
          {normalizationOptions.map(option => <SheetRow key={option.value} title={option.label} icon="speaker.wave.2.fill"
            selected={settings.normalization === option.value} onPress={() => update({ normalization: option.value })} />)}
        </SheetRows>
        <Text style={styles.note}>{normalizationNote}</Text>
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
}));
