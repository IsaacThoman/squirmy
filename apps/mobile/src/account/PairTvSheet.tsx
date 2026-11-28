import { ApiError } from '@squirmy/client-core';
import { PairingUserCode } from '@squirmy/contracts';
import { useMutation } from '@tanstack/react-query';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { Keyboard } from 'react-native';
import { SheetAction, SheetField, SheetFrame, SheetInfo, SheetNote } from '../SheetUI';
import { closeSheet } from '../closeSheet';
import { useAccount } from './AccountProvider';

export function PairTvSheet() {
  const router = useRouter();
  const { code, server } = useLocalSearchParams<{ code?: string; server?: string }>();
  const { state } = useAccount();
  if (state.status !== 'signedIn') return null;
  const onClose = () => closeSheet(router);
  const sameServer = typeof server === 'string' && new URL(state.server.url).origin === server;
  if (code && !sameServer) {
    return <SheetFrame title="Sign in a TV" onClose={onClose}>
      <SheetNote error>This link is for a different server. Switch to an account on that server or approve in your browser.</SheetNote>
    </SheetFrame>;
  }
  return <PairingForm key={`${state.server.url}:${state.user.id}:${code ?? ''}`}
    initialCode={sameServer ? PairingUserCode.safeParse(code).data : undefined}
    account={state.user.displayName ?? state.user.username} onClose={onClose} />;
}

function PairingForm({ initialCode, account, onClose }: { initialCode?: string; account: string; onClose: () => void }) {
  const { api } = useAccount();
  const [input, setInput] = useState(initialCode ?? '');
  const [invalid, setInvalid] = useState(false);
  const lookup = useMutation({ mutationFn: (code: string) => api!.auth.lookupTvPairing({ code }) });
  const approve = useMutation({
    mutationFn: ({ id, code }: { id: string; code: string }) => api!.auth.approveTvPairing({ id, code }),
  });
  const find = lookup.mutate;
  useEffect(() => {
    if (initialCode) find(initialCode);
  }, [find, initialCode]);

  const submit = () => {
    if (lookup.isPending) return;
    const code = PairingUserCode.safeParse(input);
    if (!code.success) return setInvalid(true);
    Keyboard.dismiss();
    find(code.data);
  };
  const error = lookup.error ?? approve.error;
  const preview = lookup.data;
  const code = lookup.variables ?? '';
  // A Squirmy speaker pairs the same way; older servers pair TVs only.
  const speaker = preview?.deviceKind === 'speaker';
  return (
    <SheetFrame title="Sign in a TV" onClose={onClose}>
      {approve.isSuccess ? <>
        <SheetNote>{speaker ? 'Your speaker will finish signing in by itself, then shows up in your devices.' : 'Your Apple TV will finish signing in automatically.'}</SheetNote>
        <SheetAction title="Done" onPress={onClose} />
      </> : preview ? <>
        <SheetInfo title={`Sign in ${preview.deviceName}?`} subtitle={`IP address ${preview.ipAddress}`} icon={speaker ? 'hifispeaker' : 'appletv'} />
        <SheetNote>{`Approve only if your ${speaker ? 'speaker' : 'TV'} shows ${code.slice(0, 4)}-${code.slice(4)}. It will sign in as ${account}.`}</SheetNote>
        <SheetAction title={approve.isPending ? 'Approving…' : speaker ? 'Approve Speaker' : 'Approve TV'} disabled={approve.isPending}
          onPress={() => approve.mutate({ id: preview.id, code })} />
        <SheetAction title="Enter Another Code" disabled={approve.isPending} onPress={() => {
          approve.reset();
          lookup.reset();
          setInput('');
        }} />
      </> : <>
        <SheetNote>Enter the code shown on your Apple TV, or in your Squirmy speaker’s log or status page.</SheetNote>
        <SheetField label="TV code" value={input} maxLength={9} onChange={value => { setInput(value.toUpperCase()); setInvalid(false); lookup.reset(); }} onSubmit={submit} />
        <SheetAction title={lookup.isPending ? 'Looking Up TV…' : 'Continue'} disabled={!input.trim() || lookup.isPending} onPress={submit} />
      </>}
      {invalid && <SheetNote error>Enter the eight characters shown on the TV.</SheetNote>}
      {error && <SheetNote error>{error instanceof ApiError && error.status > 0 ? error.message : 'Couldn’t reach the server. Try again.'}</SheetNote>}
    </SheetFrame>
  );
}
