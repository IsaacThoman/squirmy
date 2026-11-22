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
        <Text style={styles.heading}>Normalize volume</Text>
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
      </> : <ActivityIndicator />}
      <StorageSection />
      {screen.listenBrainz && <ListenBrainz service={screen.listenBrainz} busy={screen.connectingListenBrainz}
        onConnect={screen.connectListenBrainz} onDisconnect={() => screen.disconnect('listenbrainz')} />}
      {screen.lastFm && !screen.lastFm.available && screen.isAdmin && <Text style={styles.note}>{lastFmAdminNote}</Text>}
      {screen.lastFm?.available && <>
        <Text style={styles.heading}>Last.fm</Text>
        <SheetRows>
          <SheetRow title={screen.lastFm.connected && !screen.lastFm.needsAttention ? 'Disconnect' : 'Connect'}
            subtitle={scrobbleDetail(screen.lastFm)} icon="music.note"
            onPress={() => screen.lastFm?.connected && !screen.lastFm.needsAttention ? screen.disconnect('lastfm') : screen.connectLastFm()} />
        </SheetRows>
      </>}
    </SheetFrame>
  </ScrollView>;
}

function ListenBrainz({ service, busy, onConnect, onDisconnect }: {
  service: ScrobbleService; busy: boolean; onConnect: (token: string) => void; onDisconnect: () => void;
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
  </>;
}

const useStyles = createThemedStyles(colors => StyleSheet.create({
  heading: { color: colors.text, fontSize: 17, fontWeight: '700', marginTop: 6 },
  note: { color: colors.muted, fontSize: 13, lineHeight: 19 },
  tokenRow: { flexDirection: 'row', gap: 8, alignItems: 'center' },
  input: { flex: 1, minHeight: 44, borderRadius: 12, paddingHorizontal: 12, backgroundColor: colors.surface, color: colors.text },
  connect: { minHeight: 44, paddingHorizontal: 14, borderRadius: 12, justifyContent: 'center', backgroundColor: colors.accent },
  connectText: { color: colors.onAccent, fontWeight: '700' },
}));
