import Constants from 'expo-constants';
import * as Haptics from 'expo-haptics';
import { useRouter } from 'expo-router';
import { Alert, Platform } from 'react-native';
import { closeSheet } from '../closeSheet';
import { useDownloadsSummary } from '../downloads/DownloadsProvider';
import { formatBytes, plural } from '@squirmy/client-core';
import { SheetFrame, SheetInfo, SheetNote, SheetRow, SheetRows } from '../SheetUI';
import { displayAddress, serverVersion } from './address';
import { unsavedSignIn, useAccount } from './AccountProvider';
import { accountTitle } from './storageUsage';

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
  const { state, unsaved, accounts, signOut, addAccount, switchTo } = useAccount();
  const downloads = useDownloadsSummary();
  if (state.status !== 'signedIn') return null;
  const { server, user } = state;
  const kept = Boolean(downloads?.collections.length);
  const keptLine = downloads ? `${plural(downloads.count, 'song')} · ${formatBytes(downloads.usedBytes)}` : '';
  const others = accounts.filter(account => !account.current);
  // Downloads belong to this account on this server and wait for its next sign-in; Storage removes them.
  const signOutMessage = kept && downloads
    ? `You can sign back in at any time. The ${plural(downloads.count, 'song')} (${formatBytes(downloads.usedBytes)}) you downloaded stay on this ${Platform.OS === 'ios' ? 'iPhone' : 'phone'} for then; remove them in Settings, under Storage.`
    : 'You can sign back in at any time.';
  // The sheet closes first, and the account goes once it is off screen: otherwise the next
  // screen appears beneath a sheet still showing this account while it slides away.
  const leave = (perform: () => void) => () => {
    closeSheet(router);
    setTimeout(perform, dismissMs);
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
      {/* The other accounts saved on this phone, to open without signing in again. */}
      <SheetRows>
        {others.map(account => <SheetRow key={account.key} title={accountTitle(account)} icon="person.crop.circle"
          subtitle={account.signedIn ? account.server.name : `${account.server.name} · Signed out`}
          onPress={leave(() => void switchTo(account.key))} />)}
        <SheetRow title="Add Account" subtitle="Another server, or someone else on this one" icon="person.crop.circle.badge.plus"
          onPress={leave(addAccount)} />
      </SheetRows>
      <SheetRows>
        {/* Opened over this sheet, so closing them comes back here. */}
        <SheetRow title="Replay" subtitle="What you’ve listened to most" icon="chart.bar" onPress={() => router.push('/replay')} />
        <SheetRow title="Settings" subtitle="Volume, streaming quality, scrobbling" icon="gearshape" onPress={() => router.push('/settings')} />
        {Platform.OS === 'ios' && server.supportsTvPairing && <SheetRow title="Sign in a TV…" subtitle="Approve a code from your Apple TV or speaker"
          icon="appletv" onPress={() => router.push('/pair')} />}
        <SheetRow title="Downloads" subtitle={kept ? keptLine : 'Music kept on this device'} icon="arrow.down.circle"
          onPress={() => router.push('/downloads')} />
        {__DEV__ && <SheetRow title="Engine test bench" subtitle="Development builds only" icon="waveform"
          onPress={() => router.push('/dev/engine')} />}
        <SheetRow title="Sign out" icon="rectangle.portrait.and.arrow.right" destructive onPress={() => confirm(
          `Sign out of ${server.name}?`, signOutMessage, 'Sign Out', leave(signOut),
        )} />
      </SheetRows>
      <SheetNote mark>{`${appVersion()}\nServer ${serverVersion(server.version).toLowerCase()}`}</SheetNote>
    </SheetFrame>
  );
}
