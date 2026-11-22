import { useImperativeHandle, useRef, type ComponentRef, type ReactNode, type Ref } from 'react';
import {
  ActivityIndicator, KeyboardAvoidingView, Pressable, ScrollView, StyleSheet, Text, TextInput, View, type TextInputProps,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { BrandMark } from '../BrandMark';
import { createThemedStyles, useColors } from '../theme';
import { Icon } from '../ui';
import type { Server } from './server';
import { displayAddress, serverVersion } from './address';

export type FieldKind = 'url' | 'username' | 'password' | 'newPassword' | 'code';
/** `clear` empties the field without rebuilding it: iOS offers to save a password whose filled field disappears. */
export type FieldHandle = { focus: () => void; clear: () => void };

/** Every page before the app opens under the mascot. */
export type AuthPageProps = { title: string; message: string; children: ReactNode };
export type AuthSectionProps = { footer?: string | null; tone?: 'error' | 'note'; children: ReactNode };
export type AuthFieldProps = {
  kind: FieldKind;
  placeholder: string;
  value: string;
  onChange: (value: string) => void;
  onSubmit?: () => void;
  autoFocus?: boolean;
  ref?: Ref<FieldHandle>;
};
/** `busyTitle` replaces the title while `busy`, next to a spinner. */
export type AuthSubmitProps = { title: string; busyTitle?: string; busy?: boolean; disabled?: boolean; onPress: () => void };
export type AuthLinkProps = { title: string; icon?: string; onPress: () => void };
export type AuthServerProps = { server: Server; onChange: () => void };

const inputProps: Record<FieldKind, TextInputProps> = {
  url: { keyboardType: 'url', textContentType: 'URL', autoComplete: 'url', returnKeyType: 'go' },
  username: { textContentType: 'username', autoComplete: 'username', returnKeyType: 'next' },
  password: { textContentType: 'password', autoComplete: 'current-password', secureTextEntry: true, returnKeyType: 'go' },
  newPassword: { textContentType: 'newPassword', autoComplete: 'new-password', secureTextEntry: true, returnKeyType: 'go' },
  code: { textContentType: 'oneTimeCode', autoComplete: 'one-time-code', returnKeyType: 'next' },
};

export function AuthPage({ title, message, children }: AuthPageProps) {
  const styles = useStyles();
  const { top, bottom } = useSafeAreaInsets();
  return <KeyboardAvoidingView behavior="padding" style={styles.page}>
    <ScrollView keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag"
      contentContainerStyle={[styles.content, { paddingTop: top + 48, paddingBottom: bottom + 24 }]}>
      <View style={styles.header}>
        <View style={styles.mark}><BrandMark size={84} /></View>
        <Text accessibilityRole="header" style={styles.title}>{title}</Text>
        <Text style={styles.message}>{message}</Text>
      </View>
      {children}
    </ScrollView>
  </KeyboardAvoidingView>;
}

export function AuthSection({ footer, tone, children }: AuthSectionProps) {
  const colors = useColors();
  const styles = useStyles();
  return <View style={styles.section}>
    <View style={styles.group}>{children}</View>
    {footer ? <Text style={[styles.footer, tone === 'error' && { color: colors.danger }]}>{footer}</Text> : null}
  </View>;
}

export function AuthField({ kind, placeholder, value, onChange, onSubmit, autoFocus, ref }: AuthFieldProps) {
  const colors = useColors();
  const styles = useStyles();
  const input = useRef<ComponentRef<typeof TextInput>>(null);
  useImperativeHandle(ref, () => ({ focus: () => input.current?.focus(), clear: () => input.current?.clear() }), []);
  return <TextInput ref={input} value={value} onChangeText={onChange} onSubmitEditing={onSubmit} placeholder={placeholder}
    accessibilityLabel={placeholder} placeholderTextColor={colors.quiet} autoFocus={autoFocus} autoCapitalize="none"
    autoCorrect={false} submitBehavior={kind === 'username' || kind === 'code' ? 'submit' : 'blurAndSubmit'}
    style={styles.input} {...inputProps[kind]} />;
}

export function AuthSubmit({ title, busyTitle, busy, disabled, onPress }: AuthSubmitProps) {
  const colors = useColors();
  const styles = useStyles();
  return <Pressable accessibilityRole="button" accessibilityState={{ disabled: disabled || busy, busy }} disabled={disabled || busy}
    onPress={onPress} style={({ pressed }) => [styles.submit, disabled && !busy && styles.disabled, pressed && styles.pressed]}>
    {busy && <ActivityIndicator size="small" color={colors.onAccent} />}
    <Text style={styles.submitTitle}>{busy ? busyTitle ?? title : title}</Text>
  </Pressable>;
}

export function AuthLink({ title, icon, onPress }: AuthLinkProps) {
  const colors = useColors();
  const styles = useStyles();
  return <Pressable accessibilityRole="button" onPress={onPress} style={({ pressed }) => [styles.link, pressed && styles.pressed]}>
    {icon && <Icon name={icon} size={17} color={colors.accent} />}
    <Text style={styles.linkTitle}>{title}</Text>
  </Pressable>;
}

export function AuthServer({ server, onChange }: AuthServerProps) {
  const colors = useColors();
  const styles = useStyles();
  return <View style={styles.server}>
    <View style={styles.serverIcon}><Icon name="server.rack" size={19} color={colors.accent} /></View>
    <View style={styles.flex}>
      <Text numberOfLines={1} style={styles.serverName}>{server.name}</Text>
      <Text numberOfLines={1} ellipsizeMode="middle" style={styles.serverDetail}>{displayAddress(server.url)}</Text>
      <Text numberOfLines={1} style={styles.serverDetail}>{serverVersion(server.version)}</Text>
    </View>
    <Pressable accessibilityRole="button" accessibilityLabel="Change server" onPress={onChange} hitSlop={8}
      style={({ pressed }) => pressed && styles.pressed}>
      <Text style={styles.linkTitle}>Change</Text>
    </Pressable>
  </View>;
}

const useStyles = createThemedStyles(colors => StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.background },
  content: { paddingHorizontal: 22, gap: 22 },
  header: { alignItems: 'center', gap: 8, marginBottom: 6 },
  mark: { marginBottom: 4 },
  title: { color: colors.text, fontSize: 30, fontWeight: '800', letterSpacing: -1.1, textAlign: 'center' },
  message: { color: colors.muted, fontSize: 15, lineHeight: 21, textAlign: 'center' },
  section: { gap: 7 },
  group: { borderRadius: 16, backgroundColor: colors.surface, overflow: 'hidden' },
  footer: { color: colors.muted, fontSize: 13, lineHeight: 18, paddingHorizontal: 14 },
  input: { color: colors.text, fontSize: 16, minHeight: 50, paddingHorizontal: 14, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.stroke },
  submit: { height: 50, borderRadius: 25, backgroundColor: colors.accent, flexDirection: 'row', gap: 8, alignItems: 'center', justifyContent: 'center' },
  submitTitle: { color: colors.onAccent, fontSize: 16, fontWeight: '700' },
  disabled: { opacity: 0.45 },
  pressed: { opacity: 0.72 },
  link: { minHeight: 48, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 },
  linkTitle: { color: colors.accent, fontSize: 15, fontWeight: '600' },
  server: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 12 },
  serverIcon: { width: 36, height: 36, borderRadius: 11, backgroundColor: colors.selection, alignItems: 'center', justifyContent: 'center' },
  flex: { flex: 1, gap: 2 },
  serverName: { color: colors.text, fontSize: 15, fontWeight: '600' },
  serverDetail: { color: colors.muted, fontSize: 13 },
}));
