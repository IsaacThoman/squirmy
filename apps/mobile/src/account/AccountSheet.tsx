import * as Haptics from 'expo-haptics';
import { useRouter } from 'expo-router';
import { Alert, Platform } from 'react-native';
import { closeSheet } from '../closeSheet';
import { useDownloadActions, useDownloadsSummary } from '../downloads/DownloadsProvider';
import { formatBytes } from '../downloads/model';
import { SheetFrame, SheetInfo, SheetRow, SheetRows } from '../SheetUI';
import { displayAddress } from './address';
import { useAccount } from './AccountProvider';

export function AccountSheet() {
  const router = useRouter();
  const { state, signOut, switchServer } = useAccount();
  const downloads = useDownloadsSummary();
  const { removeAll } = useDownloadActions();
  if (state.status !== 'signedIn') return null;
  const { server, user } = state;
  const kept = Boolean(downloads?.collections.length);
  const keptLine = downloads ? `${downloads.count} ${downloads.count === 1 ? 'song' : 'songs'} · ${formatBytes(downloads.usedBytes)}` : '';
  // Downloads belong to this account on this server, so leaving removes them.
  const leaving = (message: string) => kept && downloads
    ? `${message} The ${downloads.count} ${downloads.count === 1 ? 'song' : 'songs'} (${formatBytes(downloads.usedBytes)}) downloaded from it will be removed from this ${Platform.OS === 'ios' ? 'iPhone' : 'phone'}.`
    : message;
  // The sheet closes first: left open, it would outlive the tabs beneath it for a moment.
  const leave = (perform: () => void) => () => {
    closeSheet(router);
    removeAll();
    perform();
  };

  const confirm = (title: string, message: string, action: string, perform: () => void) => {
    void Haptics.selectionAsync();
    Alert.alert(title, message, [
      { text: 'Cancel', style: 'cancel' },
      { text: action, style: 'destructive', onPress: perform },
    ]);
  };

  return (
    <SheetFrame title="Account" onClose={() => closeSheet(router)}>
      <SheetInfo icon="person.crop.circle.fill" title={user.displayName ?? user.username}
        subtitle={[user.displayName && user.username, user.role === 'admin' ? 'Admin' : 'Member'].filter(Boolean).join(' · ')} />
      <SheetInfo icon="server.rack" title={server.name} subtitle={`${displayAddress(server.url)} · Squirmy ${server.version}`} />
      <SheetRows>
        <SheetRow title="Settings" subtitle="Volume, streaming quality, scrobbling" icon="gearshape" onPress={() => router.replace('/settings')} />
        <SheetRow title="Downloads" subtitle={kept ? keptLine : 'Music kept on this device'} icon="arrow.down.circle"
          onPress={() => router.replace('/downloads')} />
        {__DEV__ && <SheetRow title="Engine test bench" subtitle="Development builds only" icon="waveform"
          onPress={() => router.push('/dev/engine')} />}
        <SheetRow title="Switch server" icon="arrow.left.arrow.right" onPress={() => confirm(
          'Switch server?', leaving(`You’ll be signed out of ${server.name}.`), 'Switch Server', leave(switchServer),
        )} />
        <SheetRow title="Sign out" icon="rectangle.portrait.and.arrow.right" onPress={() => confirm(
          `Sign out of ${server.name}?`, leaving('You can sign back in at any time.'), 'Sign Out', leave(signOut),
        )} />
      </SheetRows>
    </SheetFrame>
  );
}
