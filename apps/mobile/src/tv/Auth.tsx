import { Image } from 'expo-image';
import { tvDiscovery, type DiscoveredServer } from '../../modules/tv-discovery';
import { ApiError } from '@squirmy/client-core';
import { useMutation } from '@tanstack/react-query';
import { useEffect, useRef, useState, type ComponentRef, type ReactNode } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, TextInput, View, type TextInputProps } from 'react-native';
import { BrandMark } from '../BrandMark';
import { displayAddress, isExposedHttp } from '../account/address';
import { unsavedSignIn, useAccount } from '../account/AccountProvider';
import { signInErrorMessage } from '../account/auth';
import { ConnectError, findServer } from '../account/server';
import { lastUsername, rememberUsername } from '../account/storage';
import { Button } from './Button';
import { Focusable } from './Focusable';
import { Backdrop } from './Page';
import { colors, type } from './theme';
import { usePairing } from './usePairing';

const addressHint = 'For example music.example.com or http://192.168.1.20:4747.';

/** A centred card over the backdrop, as the system's sign-in screens are. */
function AuthCard({ title, message, children }: { title: string; message: string; children: ReactNode }) {
  return <View style={styles.page}>
    <Backdrop />
    <View style={styles.card}>
      <BrandMark size={120} />
      <Text accessibilityRole="header" style={styles.title}>{title}</Text>
      <Text style={styles.message}>{message}</Text>
      <View style={styles.fields}>{children}</View>
    </View>
  </View>;
}

type FieldProps = {
  label: string;
  value: string;
  onChange: (value: string) => void;
  onSubmit?: () => void;
  secure?: boolean;
  kind?: TextInputProps['textContentType'];
  keyboard?: TextInputProps['keyboardType'];
  hasTVPreferredFocus?: boolean;
};

/**
 * A text field as a focusable row. Selecting it opens the system keyboard, where the phone's
 * keyboard can type too; the row shows what was typed.
 */
function Field({ label, value, onChange, onSubmit, secure, kind, keyboard, hasTVPreferredFocus }: FieldProps) {
  const input = useRef<ComponentRef<typeof TextInput>>(null);
  const shown = secure ? '•'.repeat(value.length) : value;
  return <Focusable
    accessibilityLabel={label}
    accessibilityValue={{ text: secure ? undefined : value }}
    hasTVPreferredFocus={hasTVPreferredFocus}
    onPress={() => input.current?.focus()}
    scale={1.04}
    liftStyle={({ focused }) => [styles.field, focused && styles.fieldFocused]}
  >
    {({ focused }) => <>
      <Text style={[styles.fieldLabel, focused && styles.inkFocused]}>{label}</Text>
      <Text numberOfLines={1} style={[styles.fieldValue, focused && styles.inkFocused, !value && (focused ? styles.placeholderFocused : styles.placeholder)]}>{shown || 'Not entered'}</Text>
      {/* The system keyboard edits this; it is not drawn. */}
      <TextInput ref={input} value={value} onChangeText={onChange} onSubmitEditing={onSubmit} secureTextEntry={secure}
        textContentType={kind} keyboardType={keyboard} autoCapitalize="none" autoCorrect={false} placeholder={label}
        style={styles.hiddenInput} accessible={false} focusable={false} />
    </>}
  </Focusable>;
}

function Note({ text, error }: { text: string | null | undefined; error?: boolean }) {
  if (!text) return null;
  return <Text style={[styles.note, error && styles.error]}>{text}</Text>;
}

function useLocalServers() {
  const [servers, setServers] = useState<DiscoveredServer[]>([]);
  useEffect(() => {
    const discovery = tvDiscovery();
    if (!discovery) return;
    const subscription = discovery.addListener('serversChanged', event => setServers(event.servers));
    void discovery.start().catch(() => undefined);
    return () => {
      subscription.remove();
      void discovery.stop().catch(() => undefined);
    };
  }, []);
  return servers;
}

export function TvConnectScreen() {
  const { state, accounts, connect, switchTo } = useAccount();
  const previous = state.status === 'connect' ? state.previous : null;
  const servers = useLocalServers();
  const [address, setAddress] = useState(previous ? displayAddress(previous.url) : '');
  const search = useRef<AbortController | null>(null);
  const lookup = useMutation({
    mutationFn: (input: string) => {
      search.current = new AbortController();
      return findServer(input, undefined, search.current.signal);
    },
    onSuccess: server => connect(server),
  });
  const problem = lookup.error instanceof ConnectError && lookup.error.problem !== 'cancelled' ? lookup.error : null;
  const submit = (value = address) => {
    if (value.trim() && !lookup.isPending) lookup.mutate(value);
  };
  return <AuthCard title="Connect to your server" message="Choose a nearby Squirmy server or enter its address.">
    {servers.length > 0 && <ScrollView horizontal contentContainerStyle={styles.localServers}>
      {servers.map((server, index) => <Button key={server.name} label={server.name} hasTVPreferredFocus={index === 0} disabled={lookup.isPending}
        onPress={() => { setAddress(server.url); submit(server.url); }} />)}
    </ScrollView>}
    <Field label="Server address" value={address} keyboard="url" kind="URL" hasTVPreferredFocus={!servers.length}
      onChange={value => {
        setAddress(value);
        if (lookup.isPending) search.current?.abort();
        lookup.reset();
      }}
      onSubmit={() => submit()} />
    <Note text={problem ? problem.url ? `${problem.message} Setup runs in the web app at ${problem.url}.` : problem.message : addressHint} error={Boolean(problem)} />
    <View style={styles.actions}>
      {lookup.isPending
        ? <><ActivityIndicator color={colors.secondary} /><Button label="Cancel" onPress={() => { search.current?.abort(); lookup.reset(); }} /></>
        : <Button label="Continue" prominent disabled={!address.trim()} onPress={() => submit()} />}
    </View>
    {/* The household's profiles on this Apple TV, to go back to one instead. */}
    {accounts.length > 0 && !lookup.isPending && <View style={styles.secondary}>
      {accounts.map(account => <Button key={account.key} label={account.user.displayName ?? account.user.username}
        onPress={() => void switchTo(account.key)} />)}
    </View>}
  </AuthCard>;
}

type Mode = 'signIn' | 'register';

function TvPairingScreen({ onPassword }: { onPassword?: () => void }) {
  const { state, addAccount } = useAccount();
  const [attempt, setAttempt] = useState(0);
  const { code, error, finishing } = usePairing(attempt);
  if (state.status !== 'signIn') return null;
  const message = finishing ? 'Opening your account…'
    : 'Scan with your phone’s camera, or enter this code under Account → Sign in a TV in Squirmy for iOS.';
  return <AuthCard title={`Sign in to ${state.server.name}`} message={message}>
    {code ? <View style={styles.pairCode}>
      <Image source={{ uri: code.qrCode }} style={styles.qr} accessibilityLabel="TV sign-in QR code" accessible cachePolicy="none" />
      <Text style={styles.code}>{code.userCode}</Text>
      <Note text={`${displayAddress(new URL(code.verificationUrl).origin)}/pair`} />
    </View> : error ? <Note text={error} error /> : <ActivityIndicator color={colors.secondary} />}
    {!finishing && <View style={styles.actions}>
      {error && <Button label="Get a New Code" prominent hasTVPreferredFocus onPress={() => setAttempt(value => value + 1)} />}
      {onPassword && <Button label="Use Password" onPress={onPassword} />}
      <Button label="Change Server" onPress={addAccount} />
    </View>}
  </AuthCard>;
}

export function TvSignInScreen() {
  const { state } = useAccount();
  const [usePassword, setUsePassword] = useState(false);
  if (state.status !== 'signIn') return null;
  const { server } = state;
  if (server.supportsTvPairing && !usePassword) {
    return <TvPairingScreen key={server.url} onPassword={server.passwordLogin === false ? undefined : () => setUsePassword(true)} />;
  }
  return <TvPasswordSignIn onPair={server.supportsTvPairing ? () => setUsePassword(false) : undefined} />;
}

function TvPasswordSignIn({ onPair }: { onPair?: () => void }) {
  const { state, unsaved, signIn, signInWithCode, register, addAccount } = useAccount();
  const [mode, setMode] = useState<Mode>('signIn');
  // Set once the password was right and the account wants a code from an authenticator app too.
  const [challenge, setChallenge] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const serverUrl = state.status === 'signIn' ? state.server.url : '';
  const [remembered] = useState(() => lastUsername(serverUrl));
  const [inviteCode, setInviteCode] = useState('');
  const [username, setUsername] = useState(remembered);
  const [password, setPassword] = useState('');
  const attempt = useMutation({
    mutationFn: async () => {
      if (challenge) return signInWithCode(challenge, code);
      return mode === 'signIn' ? signIn(username, password) : register(inviteCode, username, password);
    },
    onSuccess: result => {
      if (result?.twoFactor) setChallenge(result.twoFactor);
      else rememberUsername(serverUrl, username.trim());
    },
    onError: error => {
      if (error instanceof ApiError && (error.code === 'invalid_credentials' || error.code === 'invalid_challenge')) setPassword('');
      if (error instanceof ApiError && error.code === 'invalid_code') setCode('');
      if (error instanceof ApiError && error.code === 'invalid_challenge') {
        setChallenge(null);
        setCode('');
      }
    },
  });
  if (state.status !== 'signIn') return null;
  const { server, notice } = state;
  const registering = mode === 'register';
  const inviteRequired = server.registrationRequiresInvite;
  const ready = Boolean(username.trim() && password && (!registering || !inviteRequired || inviteCode.trim()));
  const error = attempt.error ? signInErrorMessage(attempt.error, server.name) : null;
  const warning = isExposedHttp(server.url) ? 'This server doesn’t use HTTPS, so your password is sent unencrypted.' : null;
  const submit = () => {
    if (ready && !attempt.isPending) attempt.mutate();
  };
  if (challenge) {
    const submitCode = () => {
      if (code.trim() && !attempt.isPending) attempt.mutate();
    };
    return <AuthCard title="Enter your code" message={`Open your authenticator app and enter the code it shows for ${server.name}. Lost your phone? Enter a recovery code.`}>
      <Field label="Code" value={code} onChange={setCode} kind="oneTimeCode" hasTVPreferredFocus onSubmit={submitCode} />
      <Note text={error} error />
      <View style={styles.actions}>
        {attempt.isPending
          ? <ActivityIndicator color={colors.secondary} />
          : <Button label="Verify" prominent disabled={!code.trim()} onPress={submitCode} style={styles.primary} />}
      </View>
      <View style={styles.secondary}>
        <Button label="Back" onPress={() => {
          attempt.reset();
          setChallenge(null);
          setCode('');
          setPassword('');
        }} />
      </View>
    </AuthCard>;
  }
  return <AuthCard title={registering ? 'Create an account' : 'Sign in'}
    message={notice ?? (unsaved ? unsavedSignIn : registering
      ? inviteRequired ? `Use the invite code you were given to join ${server.name}.` : `Create an account on ${server.name}.`
      : `Sign in to listen to ${server.name} at ${displayAddress(server.url)}.`)}>
    {registering && <Field label={inviteRequired ? 'Invite code' : 'Invite code (optional)'} value={inviteCode} onChange={setInviteCode} hasTVPreferredFocus />}
    <Field label="Username" value={username} onChange={setUsername} kind="username" hasTVPreferredFocus={!registering && !remembered} />
    <Field label="Password" value={password} onChange={setPassword} secure kind={registering ? 'newPassword' : 'password'}
      hasTVPreferredFocus={!registering && Boolean(remembered)} onSubmit={submit} />
    <Note text={error ?? warning} error={Boolean(error)} />
    {/* The main action straight under the fields, so moving down from the password reaches it. */}
    <View style={styles.actions}>
      {attempt.isPending
        ? <ActivityIndicator color={colors.secondary} />
        : <Button label={registering ? 'Create Account' : 'Sign In'} prominent disabled={!ready} onPress={submit} style={styles.primary} />}
    </View>
    <View style={styles.secondary}>
      <Button label={registering ? 'I Have an Account' : inviteRequired ? 'Join with Invite' : 'Create Account'} onPress={() => {
        attempt.reset();
        setPassword('');
        setMode(registering ? 'signIn' : 'register');
      }} />
      {onPair && <Button label="Use Phone" onPress={onPair} />}
      <Button label="Change Server" onPress={addAccount} />
    </View>
  </AuthCard>;
}

const styles = StyleSheet.create({
  page: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  card: { width: 1000, alignItems: 'center' },
  title: { ...type.title1, marginTop: 36, textAlign: 'center' },
  message: { ...type.body, color: colors.secondary, textAlign: 'center', marginTop: 14, maxWidth: 900 },
  fields: { alignSelf: 'stretch', marginTop: 56, gap: 22 },
  field: { flexDirection: 'row', alignItems: 'center', height: 96, paddingHorizontal: 40, borderRadius: 20, backgroundColor: colors.platter, gap: 24 },
  fieldFocused: { backgroundColor: colors.focused },
  fieldLabel: { ...type.body, fontWeight: '600', width: 260 },
  fieldValue: { ...type.body, flex: 1, textAlign: 'right', color: colors.secondary },
  placeholder: { color: colors.tertiary },
  inkFocused: { color: colors.onFocused },
  hiddenInput: { position: 'absolute', width: 1, height: 1, opacity: 0 },
  note: { ...type.caption, color: colors.secondary, textAlign: 'center', marginTop: 4 },
  error: { color: colors.danger },
  actions: { flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 28, marginTop: 30 },
  primary: { minWidth: 420 },
  localServers: { gap: 20, paddingVertical: 12, paddingHorizontal: 12 },
  pairCode: { alignItems: 'center', gap: 12 },
  qr: { width: 252, height: 252, backgroundColor: '#fff', borderRadius: 12 },
  code: { ...type.title2, fontVariant: ['tabular-nums'], letterSpacing: 5 },
  secondary: { flexDirection: 'row', justifyContent: 'center', gap: 28, marginTop: 40 },
  placeholderFocused: { color: 'rgba(17,16,24,0.45)' },
});
