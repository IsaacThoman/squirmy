import { ApiError } from '@squirmy/client-core';
import { useMutation } from '@tanstack/react-query';
import * as Haptics from 'expo-haptics';
import { useEffect, useRef, useState } from 'react';
import { Linking, Platform } from 'react-native';
import { displayAddress, isExposedHttp } from './address';
import { unsavedSignIn, useAccount } from './AccountProvider';
import { signInErrorMessage } from './auth';
import { AuthField, AuthLink, AuthPage, AuthSection, AuthServer, AuthSubmit, type FieldHandle } from './AuthForm';
import { ConnectError, findServer } from './server';
import { lastUsername, rememberUsername } from './storage';
import { accountTitle } from './storageUsage';

const addressHint = 'For example music.example.com or http://192.168.1.20:4747.';
const savedNote = `Accounts on this ${Platform.OS === 'ios' ? 'iPhone' : 'phone'}. One that’s still signed in opens at once.`;

export function ConnectScreen() {
  const { state, accounts, connect, switchTo } = useAccount();
  const previous = state.status === 'connect' ? state.previous : null;
  const [address, setAddress] = useState(previous ? displayAddress(previous.url) : '');
  const search = useRef<AbortController | null>(null);
  const lookup = useMutation({
    mutationFn: (input: string) => {
      search.current = new AbortController();
      return findServer(input, undefined, search.current.signal);
    },
    onSuccess: server => {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      connect(server);
    },
    onError: error => {
      if (!(error instanceof ConnectError && error.problem === 'cancelled')) void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    },
  });
  const problem = lookup.error instanceof ConnectError && lookup.error.problem !== 'cancelled' ? lookup.error : null;
  const submit = () => {
    if (address.trim() && !lookup.isPending) lookup.mutate(address);
  };
  const cancel = () => {
    search.current?.abort();
    lookup.reset();
  };

  return <AuthPage title="Connect to your server"
    message="Squirmy plays the music on your own server. Enter its address to get started.">
    <AuthSection footer={problem?.message ?? addressHint} tone={problem ? 'error' : 'note'}>
      <AuthField kind="url" placeholder="Server address" value={address} autoFocus={!previous} onSubmit={submit}
        onChange={value => {
          setAddress(value);
          // Editing the address stops a search for the old one.
          if (lookup.isPending) cancel();
          else if (lookup.error) lookup.reset();
        }} />
    </AuthSection>
    {problem?.url && <AuthSection footer={`Squirmy ${problem.version}. Setup runs in the web app at ${problem.url}.`}>
      <AuthLink title="Open in Browser" icon="safari" onPress={() => void Linking.openURL(problem.url!)} />
    </AuthSection>}
    <AuthSubmit title="Continue" busyTitle="Connecting…" busy={lookup.isPending} disabled={!address.trim()} onPress={submit} />
    {lookup.isPending && <AuthSection><AuthLink title="Cancel" onPress={cancel} /></AuthSection>}
    {/* Back to an account already on this phone, as it was: adding one can be called off here. */}
    {accounts.length > 0 && !lookup.isPending && <AuthSection footer={savedNote}>
      {accounts.map(account => <AuthLink key={account.key} icon="person.crop.circle"
        title={`${accountTitle(account)} on ${account.server.name}`} onPress={() => void switchTo(account.key)} />)}
    </AuthSection>}
  </AuthPage>;
}

type Mode = 'signIn' | 'register';

export function SignInScreen() {
  const { state, unsaved, signIn, register, addAccount } = useAccount();
  const [mode, setMode] = useState<Mode>('signIn');
  const serverUrl = state.status === 'signIn' ? state.server.url : '';
  const [inviteCode, setInviteCode] = useState('');
  const [remembered] = useState(() => lastUsername(serverUrl));
  const [username, setUsername] = useState(remembered);
  const [password, setPassword] = useState('');
  const [wrongPassword, setWrongPassword] = useState(0);
  const usernameField = useRef<FieldHandle>(null);
  const passwordField = useRef<FieldHandle>(null);
  const clearPassword = () => {
    setPassword('');
    passwordField.current?.clear();
  };
  // The error's footer rebuilds the fields on iOS, which takes their focus; it goes back
  // to the password field once that has happened.
  useEffect(() => {
    if (!wrongPassword) return;
    const timer = setTimeout(() => passwordField.current?.focus(), 50);
    return () => clearTimeout(timer);
  }, [wrongPassword]);
  const attempt = useMutation({
    mutationFn: () => mode === 'signIn' ? signIn(username, password) : register(inviteCode, username, password),
    onSuccess: () => {
      rememberUsername(serverUrl, username.trim());
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    },
    onError: error => {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      // Like any iOS sign-in: the wrong password goes, and the keyboard stays up to retype it.
      if (error instanceof ApiError && error.code === 'invalid_credentials') {
        clearPassword();
        setWrongPassword(count => count + 1);
      }
    },
  });
  if (state.status !== 'signIn') return null;

  const { server, notice } = state;
  const registering = mode === 'register';
  const inviteRequired = server.registrationRequiresInvite;
  const ready = Boolean(username.trim() && password && (!registering || !inviteRequired || inviteCode.trim()));
  // Shown until the next attempt: on iOS, changing a section's footer rebuilds its fields,
  // which would cut off typing in the password field.
  const error = attempt.error ? signInErrorMessage(attempt.error, server.name) : null;
  const warning = isExposedHttp(server.url) ? 'This server doesn’t use HTTPS, so your password is sent unencrypted.' : null;
  const submit = () => {
    if (ready && !attempt.isPending) attempt.mutate();
  };

  return <AuthPage title={registering ? 'Create an account' : 'Sign in'}
    // A keychain that refused here won't keep this sign-in either, so the page says so before it is typed.
    message={notice ?? (unsaved ? unsavedSignIn : registering
      ? inviteRequired ? `Use the invite code you were given to join ${server.name}.` : `Create an account on ${server.name}.`
      : `Sign in to listen to ${server.name}.`)}>
    <AuthServer server={server} onChange={addAccount} />
    {registering && <AuthSection footer={inviteRequired
      ? 'Ask the person who runs this server for an invite code.'
      : 'An invite code can give your account more permissions. You can leave it empty.'}>
      <AuthField kind="code" placeholder={inviteRequired ? 'Invite code' : 'Invite code (optional)'} value={inviteCode} onChange={setInviteCode} autoFocus
        onSubmit={() => usernameField.current?.focus()} />
    </AuthSection>}
    <AuthSection footer={error ?? warning} tone={error ? 'error' : 'note'}>
      <AuthField ref={usernameField} kind="username" placeholder="Username" value={username} onChange={setUsername}
        autoFocus={!registering && !remembered} onSubmit={() => passwordField.current?.focus()} />
      <AuthField ref={passwordField} kind={registering ? 'newPassword' : 'password'} placeholder="Password" value={password}
        onChange={setPassword} onSubmit={submit} autoFocus={!registering && Boolean(remembered)} />
    </AuthSection>
    <AuthSubmit title={registering ? 'Create Account' : 'Sign In'} busyTitle={registering ? 'Creating Account…' : 'Signing In…'}
      busy={attempt.isPending} disabled={!ready} onPress={submit} />
    <AuthSection>
      <AuthLink title={registering ? 'I already have an account' : inviteRequired ? 'Join with an invite code' : 'Create an account'}
        icon={registering ? 'person.crop.circle' : 'ticket'} onPress={() => {
          attempt.reset();
          // A password typed to sign in is not one chosen for a new account.
          clearPassword();
          setMode(registering ? 'signIn' : 'register');
        }} />
    </AuthSection>
  </AuthPage>;
}
