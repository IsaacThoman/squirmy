import * as Haptics from 'expo-haptics';
import { useRouter } from 'expo-router';
import { Alert } from 'react-native';
import { closeSheet } from '../closeSheet';
import { SheetFrame, SheetInfo, SheetRow, SheetRows } from '../SheetUI';
import { displayAddress } from './address';
import { useAccount } from './AccountProvider';

export function AccountSheet() {
  const router = useRouter();
  const { state, signOut, switchServer } = useAccount();
  if (state.status !== 'signedIn') return null;
  const { server, user } = state;

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
        {__DEV__ && <SheetRow title="Engine test bench" subtitle="Development builds only" icon="waveform"
          onPress={() => router.push('/dev/engine')} />}
        <SheetRow title="Switch server" icon="arrow.left.arrow.right" onPress={() => confirm(
          'Switch server?', `You’ll be signed out of ${server.name}.`, 'Switch Server', switchServer,
        )} />
        <SheetRow title="Sign out" icon="rectangle.portrait.and.arrow.right" onPress={() => confirm(
          `Sign out of ${server.name}?`, 'You can sign back in at any time.', 'Sign Out', signOut,
        )} />
      </SheetRows>
    </SheetFrame>
  );
}
