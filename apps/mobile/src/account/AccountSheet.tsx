import Constants from 'expo-constants';
import * as Haptics from 'expo-haptics';
import { useRouter } from 'expo-router';
import { Alert, Platform } from 'react-native';
import { closeSheet } from '../closeSheet';
import { useDownloadActions, useDownloadsSummary } from '../downloads/DownloadsProvider';
import { formatBytes } from '../downloads/model';
import { SheetFrame, SheetInfo, SheetNote, SheetRow, SheetRows } from '../SheetUI';
import { displayAddress, serverVersion } from './address';
import { unsavedSignIn, useAccount } from './AccountProvider';

/**
 * About as long as a sheet takes to slide away. The closed sheet's route is already gone,
 * so no transition event reaches this screen to say when it has.
 */
const dismissMs = 400;

/** This app's version and build, for bug reports: `Squirmy for iOS 1.0.0 (12)`. */
function appVersion(): string {
  const version = Constants.expoConfig?.version ?? '';
  const build = Platform.OS === 'ios' ? Constants.platform?.ios?.buildNumber : null;
  return `Squirmy for ${Platform.OS === 'ios' ? 'iOS' : 'Android'} ${version}${build ? ` (${build})` : ''}`.trim();
}

export function AccountSheet() {
  const router = useRouter();
  const { state, unsaved, signOut, switchServer } = useAccount();
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
  // The sheet closes first, and the account goes once it is off screen: otherwise the
  // sign-in screen appears beneath a sheet still showing this account while it slides away.
  const leave = (perform: () => void) => () => {
    closeSheet(router);
    setTimeout(() => {
      removeAll();
      perform();
    }, dismissMs);
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
      <SheetInfo icon="server.rack" title={server.name} subtitle={displayAddress(server.url)} address />
      {unsaved && <SheetNote error>{unsavedSignIn}</SheetNote>}
      <SheetRows>
        {/* Opened over this sheet, so closing them comes back here. */}
        <SheetRow title="Settings" subtitle="Volume, streaming quality, scrobbling" icon="gearshape" onPress={() => router.push('/settings')} />
        <SheetRow title="Downloads" subtitle={kept ? keptLine : 'Music kept on this device'} icon="arrow.down.circle"
          onPress={() => router.push('/downloads')} />
        {__DEV__ && <SheetRow title="Engine test bench" subtitle="Development builds only" icon="waveform"
          onPress={() => router.push('/dev/engine')} />}
        <SheetRow title="Switch server" icon="arrow.left.arrow.right" onPress={() => confirm(
          'Switch server?', leaving(`You’ll be signed out of ${server.name}.`), 'Switch Server', leave(switchServer),
        )} />
        <SheetRow title="Sign out" icon="rectangle.portrait.and.arrow.right" destructive onPress={() => confirm(
          `Sign out of ${server.name}?`, leaving('You can sign back in at any time.'), 'Sign Out', leave(signOut),
        )} />
      </SheetRows>
      <SheetNote mark>{`${appVersion()}\nServer ${serverVersion(server.version).toLowerCase()}`}</SheetNote>
    </SheetFrame>
  );
}
