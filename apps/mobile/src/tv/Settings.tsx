import { Alert, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { NormalizationMode, StreamQuality } from '@squirmy/contracts';
import { useAccount } from '../account/AccountProvider';
import { displayAddress, serverVersion } from '../account/address';
import { useUpdateSettings, useUserSettings } from '../data/queries';
import { TvButton, TvScreen, tvColors } from './ui';

const qualities: ReadonlyArray<{ label: string; value: StreamQuality }> = [
  { label: 'Original', value: 'original' }, { label: 'High', value: 'high' }, { label: 'Data Saver', value: 'data_saver' },
];
const normalization: ReadonlyArray<{ label: string; value: NormalizationMode }> = [
  { label: 'Automatic', value: 'auto' }, { label: 'Per Song', value: 'track' },
  { label: 'Per Album', value: 'album' }, { label: 'Off', value: 'off' },
];

export function TvSettings() {
  const { state, signOut, switchServer, unsaved } = useAccount();
  const settings = useUserSettings();
  const update = useUpdateSettings();
  if (state.status !== 'signedIn') return null;

  const confirm = (label: string, message: string, onPress: () => void) => {
    Alert.alert(label, message, [{ text: 'Cancel', style: 'cancel' }, { text: label, style: 'destructive', onPress }]);
  };
  return <TvScreen>
    <ScrollView contentContainerStyle={styles.content}>
      <Text accessibilityRole="header" style={styles.title}>Settings</Text>
      <View style={styles.panel}>
        <View style={styles.account}>
          <View style={styles.accountText}>
            <Text style={styles.heading}>{state.server.name}</Text>
            <Text style={styles.subtitle}>{displayAddress(state.server.url)} · {serverVersion(state.server.version)}</Text>
            <Text style={styles.subtitle}>Signed in as {state.user.username}</Text>
            {unsaved && <Text style={styles.problem}>Your sign-in could only be kept for this launch.</Text>}
          </View>
          <View style={styles.actions}>
            <TvButton label="Change server" onPress={() => confirm('Change server', 'Sign out and enter the address of another server?', switchServer)} />
            <TvButton label="Sign out" onPress={() => confirm('Sign out', 'Sign out of Squirmy on this Apple TV?', signOut)} />
          </View>
        </View>
      </View>
      <Text accessibilityRole="header" style={styles.heading}>Playback</Text>
      <View style={styles.panel}>
        {settings.data && <>
          <View style={styles.setting}>
            <Text style={styles.subtitle}>Streaming quality</Text>
            <View style={styles.actions}>{qualities.map(option => <TvButton key={option.value} label={option.label}
              selected={settings.data.qualityWifi === option.value} disabled={update.isPending}
              onPress={() => update.mutate({ qualityWifi: option.value })} />)}</View>
          </View>
          <View style={styles.setting}>
            <Text style={styles.subtitle}>Volume normalization</Text>
            <View style={styles.actions}>{normalization.map(option => <TvButton key={option.value} label={option.label}
              selected={settings.data.normalization === option.value} disabled={update.isPending}
              onPress={() => update.mutate({ normalization: option.value })} />)}</View>
          </View>
        </>}
        {settings.isPending && <Text style={styles.subtitle}>Loading playback settings…</Text>}
        {settings.isError && <TvButton label="Retry loading settings" onPress={() => void settings.refetch()} />}
        {update.isError && <Text accessibilityRole="alert" style={styles.problem}>Couldn’t save that change. Try again.</Text>}
      </View>
    </ScrollView>
  </TvScreen>;
}

const styles = StyleSheet.create({
  content: { gap: 24, paddingBottom: 80, paddingTop: 12 },
  title: { fontSize: 63, fontWeight: '700', color: tvColors.text, letterSpacing: -2 },
  heading: { fontSize: 34, fontWeight: '700', color: tvColors.text },
  subtitle: { fontSize: 25, color: tvColors.muted },
  problem: { fontSize: 24, color: tvColors.danger },
  panel: { gap: 26, borderRadius: 28, borderWidth: 1, borderColor: tvColors.border, padding: 28, backgroundColor: '#211C2B' },
  account: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 24 },
  accountText: { flexGrow: 1, gap: 8 },
  setting: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 14 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 14 },
});
