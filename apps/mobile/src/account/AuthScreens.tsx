import { ApiError } from '@squirmy/client-core';
import { useMutation } from '@tanstack/react-query';
import * as Haptics from 'expo-haptics';
import { useEffect, useRef, useState } from 'react';
import { Linking } from 'react-native';
import { displayAddress, isExposedHttp } from './address';
import { SsoError, unsavedSignIn, useAccount } from './AccountProvider';
import { signInErrorMessage, ssoErrorMessage } from './auth';
import { AuthField, AuthLink, AuthPage, AuthSection, AuthServer, AuthSubmit, type FieldHandle } from './AuthForm';
import { ConnectError, findServer } from './server';
import { lastUsername, rememberUsername } from './storage';

const addressHint = 'For example music.example.com or http://192.168.1.20:4747.';

export function ConnectScreen() {
  const { state, connect } = useAccount();
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
  </AuthPage>;
}

type Mode = 'signIn' | 'register';

export function SignInScreen() {
  const { state, unsaved, signIn, signInWithCode, signInWithSso, register, switchServer } = useAccount();
  const sso = useMutation({
    mutationFn: signInWithSso,
    onSuccess: () => void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success),
    onError: () => void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error),
  });
  const [mode, setMode] = useState<Mode>('signIn');
  // Set once the password was right and the account wants a code from an authenticator app too.
  const [challenge, setChallenge] = useState<string | null>(null);
  const [code, setCode] = useState('');
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
    mutationFn: async () => {
      if (challenge) return signInWithCode(challenge, code);
      return mode === 'signIn' ? signIn(username, password) : register(inviteCode, username, password);
    },
    onSuccess: result => {
      if (result?.twoFactor) {
        setChallenge(result.twoFactor);
        return;
      }
      rememberUsername(serverUrl, username.trim());
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    },
    onError: error => {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      if (error instanceof ApiError && error.code === 'invalid_code') setCode('');
      // The step is gone (too slow, or too many wrong codes): back to the password.
      if (error instanceof ApiError && error.code === 'invalid_challenge') {
        setChallenge(null);
        setCode('');
        clearPassword();
      }
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
  const ssoName = server.ssoName ?? 'single sign-on';
  const error = sso.error
    ? sso.error instanceof SsoError ? ssoErrorMessage(sso.error.code, ssoName) : signInErrorMessage(sso.error, server.name)
    : attempt.error ? signInErrorMessage(attempt.error, server.name) : null;
  const passwordsOff = server.passwordLogin === false && !registering;
  const warning = isExposedHttp(server.url) ? 'This server doesn’t use HTTPS, so your password is sent unencrypted.' : null;
  const submit = () => {
    if (ready && !attempt.isPending) attempt.mutate();
  };

  if (challenge) {
    const submitCode = () => {
      if (code.trim() && !attempt.isPending) attempt.mutate();
    };
    return <AuthPage title="Enter your code" message={`Open your authenticator app and enter the code it shows for ${server.name}.`}>
      <AuthServer server={server} onChange={switchServer} />
      <AuthSection footer={error ?? 'Lost your phone? Enter one of your recovery codes instead.'} tone={error ? 'error' : 'note'}>
        <AuthField kind="code" placeholder="Authentication code" value={code} onChange={setCode} onSubmit={submitCode} autoFocus />
      </AuthSection>
      <AuthSubmit title="Verify" busyTitle="Verifying…" busy={attempt.isPending} disabled={!code.trim()} onPress={submitCode} />
      <AuthSection>
        <AuthLink title="Back to sign in" icon="chevron.backward" onPress={() => {
          attempt.reset();
          setChallenge(null);
          setCode('');
          clearPassword();
        }} />
      </AuthSection>
    </AuthPage>;
  }

  const ssoButton = server.ssoName && !registering
    ? <AuthSubmit title={`Sign In with ${server.ssoName}`} busyTitle="Signing In…" busy={sso.isPending} disabled={attempt.isPending}
      onPress={() => { attempt.reset(); sso.mutate(); }} />
    : null;

  if (passwordsOff) {
    // Only single sign-on (passkeys are web-only for now): what went wrong is said in the page's message.
    return <AuthPage title="Sign in" message={error ?? notice ?? (server.ssoName ? `Sign in to listen to ${server.name}.` : `${server.name} doesn’t take passwords, and has no single sign-on set up.`)}>
      <AuthServer server={server} onChange={switchServer} />
      {ssoButton}
    </AuthPage>;
  }

  return <AuthPage title={registering ? 'Create an account' : 'Sign in'}
    // A keychain that refused here won't keep this sign-in either, so the page says so before it is typed.
    message={notice ?? (unsaved ? unsavedSignIn : registering
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
        autoFocus={!registering && !remembered} onSubmit={() => passwordField.current?.focus()} />
      <AuthField ref={passwordField} kind={registering ? 'newPassword' : 'password'} placeholder="Password" value={password}
        onChange={setPassword} onSubmit={submit} autoFocus={!registering && Boolean(remembered)} />
    </AuthSection>
    <AuthSubmit title={registering ? 'Create Account' : 'Sign In'} busyTitle={registering ? 'Creating Account…' : 'Signing In…'}
      busy={attempt.isPending} disabled={!ready || sso.isPending} onPress={() => { sso.reset(); submit(); }} />
    {ssoButton}
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
