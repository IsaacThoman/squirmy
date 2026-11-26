import { useMutation } from '@tanstack/react-query';
import { useEffect, useRef, useState, type ComponentRef, type PropsWithChildren, type Ref } from 'react';
import { StyleSheet, Text, TextInput, View, type TextInputProps } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { BrandMark } from '../BrandMark';
import { displayAddress, isExposedHttp } from '../account/address';
import { unsavedSignIn, useAccount } from '../account/AccountProvider';
import { signInErrorMessage } from '../account/auth';
import { findServer, type Server } from '../account/server';
import { lastUsername, rememberUsername } from '../account/storage';
import { TvButton, tvColors } from './ui';

function AuthLayout({ title, message, children }: PropsWithChildren<{ title: string; message: string }>) {
  return <LinearGradient colors={['#251B40', '#12101C', '#100F17']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.page}>
    <View style={styles.intro}>
      <BrandMark size={134} />
      <Text style={styles.wordmark}>Squirmy</Text>
      <Text style={styles.introText}>Your music library, on Apple TV.</Text>
    </View>
    <View style={styles.form}>
      <Text accessibilityRole="header" style={styles.title}>{title}</Text>
      <Text style={styles.message}>{message}</Text>
      {children}
    </View>
  </LinearGradient>;
}

function Field({ label, inputRef, ...props }: TextInputProps & { label: string; inputRef?: Ref<ComponentRef<typeof TextInput>> }) {
  const [focused, setFocused] = useState(false);
  return <View style={styles.field}>
    <Text style={styles.fieldLabel}>{label}</Text>
    <TextInput {...props} ref={inputRef} accessibilityLabel={label} placeholderTextColor={tvColors.muted}
      selectionColor={tvColors.accent} keyboardAppearance="dark" autoCapitalize="none" autoCorrect={false}
      onFocus={() => setFocused(true)} onBlur={() => setFocused(false)} style={[styles.input, focused && styles.focusedInput]} />
  </View>;
}

export function TvConnect() {
  const { state, connect } = useAccount();
  const previous = state.status === 'connect' ? state.previous : null;
  const [address, setAddress] = useState(previous ? displayAddress(previous.url) : '');
  const search = useRef<AbortController | null>(null);
  useEffect(() => () => search.current?.abort(), []);
  const lookup = useMutation({
    mutationFn: (input: string) => {
      search.current?.abort();
      search.current = new AbortController();
      return findServer(input, undefined, search.current.signal);
    },
    onSuccess: connect,
  });
  const cancel = () => { search.current?.abort(); lookup.reset(); };
  const submit = () => { if (address.trim() && !lookup.isPending) lookup.mutate(address); };
  return <AuthLayout title="Connect to your server" message="Enter the address of your Squirmy server.">
    <Field label="Server address" value={address} onChangeText={value => { setAddress(value); cancel(); }}
      placeholder="music.example.com" autoComplete="url" keyboardType="url" returnKeyType="go" onSubmitEditing={submit} />
    {lookup.error && <Text accessibilityRole="alert" style={styles.problem}>{lookup.error.message}</Text>}
    <View style={styles.buttons}>
      <TvButton label={lookup.isPending ? 'Connecting…' : 'Continue'} onPress={submit} disabled={lookup.isPending || !address.trim()} tone="primary" />
      {lookup.isPending && <TvButton label="Cancel" onPress={cancel} />}
    </View>
  </AuthLayout>;
}

export function TvSignIn({ server, notice }: { server: Server; notice: string | null }) {
  const { signIn, switchServer, unsaved } = useAccount();
  const [username, setUsername] = useState(() => lastUsername(server.url));
  const [password, setPassword] = useState('');
  const passwordField = useRef<ComponentRef<typeof TextInput>>(null);
  const attempt = useMutation({
    mutationFn: () => signIn(username, password),
    onSuccess: () => rememberUsername(server.url, username.trim()),
  });
  const submit = () => {
    if (username.trim() && password && !attempt.isPending) attempt.mutate();
  };
  return <AuthLayout title="Sign in" message={`${server.name} · ${displayAddress(server.url)}`}>
    {notice && <Text style={styles.message}>{notice}</Text>}
    {isExposedHttp(server.url) && <Text style={styles.problem}>This server uses HTTP. Your sign-in travels over the internet without encryption.</Text>}
    <Field label="Username" value={username} onChangeText={setUsername} autoComplete="username" returnKeyType="next"
      onSubmitEditing={() => passwordField.current?.focus()} editable={!attempt.isPending} />
    <Field label="Password" value={password} onChangeText={setPassword} inputRef={passwordField} autoComplete="current-password"
      secureTextEntry returnKeyType="go" onSubmitEditing={submit} editable={!attempt.isPending} />
    {attempt.error && <Text accessibilityRole="alert" style={styles.problem}>{signInErrorMessage(attempt.error, server.name)}</Text>}
    {unsaved && <Text style={styles.problem}>{unsavedSignIn}</Text>}
    <View style={styles.buttons}>
      <TvButton label={attempt.isPending ? 'Signing in…' : 'Sign in'} tone="primary" onPress={submit} disabled={!username.trim() || !password || attempt.isPending} />
      <TvButton label="Change server" onPress={switchServer} disabled={attempt.isPending} />
    </View>
  </AuthLayout>;
}

const styles = StyleSheet.create({
  page: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 115, padding: 74 },
  intro: { minWidth: 318, gap: 18 },
  wordmark: { color: tvColors.text, fontSize: 84, fontWeight: '800', letterSpacing: -5 },
  introText: { color: tvColors.muted, fontSize: 30 },
  form: { width: 640, maxWidth: '54%', gap: 19, padding: 38, backgroundColor: '#1E1A2B', borderWidth: 1, borderColor: tvColors.border, borderRadius: 34 },
  title: { color: tvColors.text, fontSize: 49, fontWeight: '700', letterSpacing: -1 },
  message: { color: tvColors.muted, fontSize: 25 },
  problem: { color: tvColors.danger, fontSize: 23 },
  field: { gap: 7 },
  fieldLabel: { color: tvColors.muted, fontWeight: '600', fontSize: 22 },
  input: { minHeight: 58, paddingHorizontal: 18, color: tvColors.text, fontSize: 27, borderWidth: 2, borderColor: tvColors.border, borderRadius: 15, backgroundColor: '#100E19' },
  focusedInput: { borderColor: tvColors.accent },
  buttons: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 16, paddingTop: 8 },
});
