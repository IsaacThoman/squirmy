import { useMutation } from '@tanstack/react-query';
import * as Haptics from 'expo-haptics';
import { useRef, useState } from 'react';
import { Linking } from 'react-native';
import { displayAddress, isExposedHttp } from './address';
import { useAccount } from './AccountProvider';
import { signInErrorMessage } from './auth';
import { AuthField, AuthLink, AuthPage, AuthSection, AuthServer, AuthSubmit, type FieldHandle } from './AuthForm';
import { ConnectError, findServer } from './server';

const addressHint = 'For example music.example.com or http://192.168.1.20:4747.';

export function ConnectScreen() {
  const { state, connect } = useAccount();
  const previous = state.status === 'connect' ? state.previous : null;
  const [address, setAddress] = useState(previous ? displayAddress(previous.url) : '');
  const lookup = useMutation({
    mutationFn: (input: string) => findServer(input),
    onSuccess: server => {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      connect(server);
    },
    onError: () => void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error),
  });
  const problem = lookup.error instanceof ConnectError ? lookup.error : null;
  const submit = () => {
    if (address.trim() && !lookup.isPending) lookup.mutate(address);
  };

  return <AuthPage icon="server.rack" title="Connect to your server"
    message="Squirmy plays the music on your own server. Enter its address to get started.">
    <AuthSection footer={problem?.message ?? addressHint} tone={problem ? 'error' : 'note'}>
      <AuthField kind="url" placeholder="Server address" value={address} autoFocus={!previous} onSubmit={submit}
        onChange={value => {
          setAddress(value);
          if (lookup.error) lookup.reset();
        }} />
    </AuthSection>
    {problem?.url && <AuthSection footer={`Setup runs in the web app at ${problem.url}.`}>
      <AuthLink title="Open in Browser" icon="safari" onPress={() => void Linking.openURL(problem.url!)} />
    </AuthSection>}
    <AuthSubmit title="Continue" busy={lookup.isPending} disabled={!address.trim()} onPress={submit} />
  </AuthPage>;
}

type Mode = 'signIn' | 'register';

export function SignInScreen() {
  const { state, signIn, register, switchServer } = useAccount();
  const [mode, setMode] = useState<Mode>('signIn');
  const [inviteCode, setInviteCode] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const usernameField = useRef<FieldHandle>(null);
  const passwordField = useRef<FieldHandle>(null);
  const attempt = useMutation({
    mutationFn: () => mode === 'signIn' ? signIn(username, password) : register(inviteCode, username, password),
    onSuccess: () => void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success),
    onError: () => void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error),
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

  return <AuthPage icon={registering ? 'person.crop.circle.badge.plus' : 'person.crop.circle'}
    title={registering ? 'Create an account' : 'Sign in'}
    message={notice ?? (registering
      ? inviteRequired ? `Use the invite code you were given to join ${server.name}.` : `Create an account on ${server.name}.`
      : `Sign in to listen to ${server.name}.`)}>
    <AuthServer server={server} onChange={switchServer} />
    {registering && <AuthSection footer={inviteRequired
      ? 'Ask the person who runs this server for an invite code.'
      : 'An invite code can give your account more permissions. You can leave it empty.'}>
      <AuthField kind="code" placeholder={inviteRequired ? 'Invite code' : 'Invite code (optional)'} value={inviteCode} onChange={setInviteCode} autoFocus
        onSubmit={() => usernameField.current?.focus()} />
    </AuthSection>}
    <AuthSection footer={error ?? warning} tone={error ? 'error' : 'note'}>
      <AuthField ref={usernameField} kind="username" placeholder="Username" value={username} onChange={setUsername}
        autoFocus={!registering} onSubmit={() => passwordField.current?.focus()} />
      <AuthField ref={passwordField} kind={registering ? 'newPassword' : 'password'} placeholder="Password" value={password}
        onChange={setPassword} onSubmit={submit} />
    </AuthSection>
    <AuthSubmit title={registering ? 'Create Account' : 'Sign In'} busy={attempt.isPending} disabled={!ready} onPress={submit} />
    <AuthSection>
      <AuthLink title={registering ? 'I already have an account' : inviteRequired ? 'Join with an invite code' : 'Create an account'}
        icon={registering ? 'person.crop.circle' : 'ticket'} onPress={() => {
          attempt.reset();
          setMode(registering ? 'signIn' : 'register');
        }} />
    </AuthSection>
  </AuthPage>;
}
