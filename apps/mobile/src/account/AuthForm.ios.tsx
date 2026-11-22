import {
  Button, Form, Host, HStack, ProgressView, Section, SecureField, Spacer, Text, TextField, VStack, useNativeState,
  type SecureFieldRef, type TextFieldRef,
} from '@expo/ui/swift-ui';
import {
  accessibilityAddTraits, accessibilityLabel, autocorrectionDisabled, buttonStyle, controlSize, disabled, font, foregroundStyle,
  frame, keyboardType, lineLimit, listRowBackground, listRowInsets, multilineTextAlignment, onSubmit, padding,
  scrollDismissesKeyboard, submitLabel, textContentType, textInputAutocapitalization, tint, truncationMode,
} from '@expo/ui/swift-ui/modifiers';
import { isLiquidGlassAvailable } from 'expo-glass-effect';
import { useImperativeHandle, useRef, useState } from 'react';
import { KeyboardAvoidingView, StyleSheet, useWindowDimensions } from 'react-native';
import { isAccessibilitySize } from '../fontScale';
import { Symbol } from '../native/Controls';
import { useColors } from '../theme';
import { displayAddress, serverVersion } from './address';
import type {
  AuthFieldProps, AuthLinkProps, AuthPageProps, AuthSectionProps, AuthServerProps, AuthSubmitProps, FieldKind,
} from './AuthForm';

export type { FieldHandle } from './AuthForm';

const clearRow = [listRowBackground('clear'), listRowInsets({ top: 0, leading: 0, bottom: 0, trailing: 0 })];

const fieldModifiers: Record<FieldKind, ReturnType<typeof textContentType>[]> = {
  url: [keyboardType('url'), textContentType('URL'), submitLabel('go')],
  username: [textContentType('username'), submitLabel('next')],
  password: [textContentType('password'), submitLabel('go')],
  newPassword: [textContentType('newPassword'), submitLabel('go')],
  code: [textContentType('oneTimeCode'), submitLabel('next')],
};

export function AuthPage({ icon, title, message, children }: AuthPageProps) {
  const colors = useColors();
  // The form is hosted in a React Native view, which is what has to make room for the keyboard.
  return <KeyboardAvoidingView behavior="padding" style={styles.page}>
    <Host style={styles.page}>
      <Form modifiers={[scrollDismissesKeyboard('interactively')]}>
        <Section modifiers={clearRow}>
          <VStack spacing={8} modifiers={[frame({ maxWidth: Infinity }), padding({ top: 28, bottom: 4 })]}>
            <VStack modifiers={[padding({ bottom: 8 })]}><Symbol name={icon} size={46} color={colors.accent} /></VStack>
            <Text modifiers={[font({ textStyle: 'title', weight: 'bold' }), multilineTextAlignment('center'),
              accessibilityAddTraits(['isHeader'])]}>{title}</Text>
            <Text modifiers={[font({ textStyle: 'subheadline' }), foregroundStyle(colors.muted), multilineTextAlignment('center')]}>{message}</Text>
          </VStack>
        </Section>
        {children}
      </Form>
    </Host>
  </KeyboardAvoidingView>;
}

export function AuthSection({ footer, tone, children }: AuthSectionProps) {
  const colors = useColors();
  return <Section footer={footer
    ? <Text modifiers={[foregroundStyle(tone === 'error' ? colors.danger : colors.muted)]}>{footer}</Text>
    : undefined}>
    {children}
  </Section>;
}

export function AuthField({ kind, placeholder, value, onChange, onSubmit: submit, autoFocus, ref }: AuthFieldProps) {
  const text = useNativeState(value);
  const field = useRef<TextFieldRef & SecureFieldRef>(null);
  // SwiftUI applies autoFocus whenever a form row reappears, which happens when a section
  // around it changes; only the first appearance should take focus.
  const [focusedOnce, setFocusedOnce] = useState(false);
  const focus = autoFocus && !focusedOnce;
  const onFocusChange = (focused: boolean) => {
    if (focused) setFocusedOnce(true);
  };
  useImperativeHandle(ref, () => ({ focus: () => { void field.current?.focus(); }, clear: () => text.set('') }), [text]);
  const modifiers = [
    accessibilityLabel(placeholder), autocorrectionDisabled(), textInputAutocapitalization('never'),
    ...fieldModifiers[kind], ...(submit ? [onSubmit(submit)] : []),
  ];
  return kind === 'password' || kind === 'newPassword'
    ? <SecureField ref={field} text={text} onTextChange={onChange} onFocusChange={onFocusChange} placeholder={placeholder}
      autoFocus={focus} modifiers={modifiers} />
    : <TextField ref={field} text={text} onTextChange={onChange} onFocusChange={onFocusChange} placeholder={placeholder}
      autoFocus={focus} modifiers={modifiers} />;
}

export function AuthSubmit({ title, busyTitle, busy, disabled: off, onPress }: AuthSubmitProps) {
  const colors = useColors();
  // Busy keeps the accent fill (a disabled button turns gray and hides the spinner); the
  // screen ignores presses meanwhile. The row's height is fixed so the spinner moves nothing.
  return <Section modifiers={clearRow}>
    <Button onPress={onPress} modifiers={[
      buttonStyle(isLiquidGlassAvailable() ? 'glassProminent' : 'borderedProminent'), controlSize('large'), tint(colors.accent),
      disabled(Boolean(off) && !busy), accessibilityLabel(busy ? busyTitle ?? title : title),
    ]}>
      <HStack spacing={8} modifiers={[frame({ maxWidth: Infinity, minHeight: 24, maxHeight: 24 })]}>
        {busy && <ProgressView modifiers={[controlSize('small'), tint(colors.onAccent)]} />}
        <Text modifiers={[font({ textStyle: 'headline' }), foregroundStyle(colors.onAccent), lineLimit(1)]}>{busy ? busyTitle ?? title : title}</Text>
      </HStack>
    </Button>
  </Section>;
}

export function AuthLink({ title, icon, onPress }: AuthLinkProps) {
  const colors = useColors();
  return <Button onPress={onPress} modifiers={[tint(colors.accent)]}>
    <HStack spacing={10}>
      {icon && <Symbol name={icon} size={17} color={colors.accent} />}
      <Text modifiers={[foregroundStyle(colors.accent)]}>{title}</Text>
    </HStack>
  </Button>;
}

export function AuthServer({ server, onChange }: AuthServerProps) {
  const colors = useColors();
  const { fontScale } = useWindowDimensions();
  // At accessibility sizes the card stacks, so the address can wrap whole: it is how the
  // person knows which server is asking for their password.
  if (isAccessibilitySize(fontScale)) {
    return <Section title="Server">
      <VStack alignment="leading" spacing={4}>
        <HStack spacing={12}>
          <Symbol name="server.rack" size={20} color={colors.accent} />
          <Text modifiers={[font({ textStyle: 'body', weight: 'semibold' })]}>{server.name}</Text>
        </HStack>
        <Text modifiers={[font({ textStyle: 'footnote' }), foregroundStyle(colors.muted)]}>{displayAddress(server.url)}</Text>
        <Text modifiers={[font({ textStyle: 'footnote' }), foregroundStyle(colors.muted)]}>{serverVersion(server.version)}</Text>
      </VStack>
      <Button label="Change Server" onPress={onChange} modifiers={[tint(colors.accent)]} />
    </Section>;
  }
  return <Section title="Server">
    <HStack spacing={12}>
      <Symbol name="server.rack" size={20} color={colors.accent} />
      <VStack alignment="leading" spacing={2}>
        <Text modifiers={[font({ textStyle: 'body', weight: 'semibold' }), lineLimit(1)]}>{server.name}</Text>
        <Text modifiers={[font({ textStyle: 'footnote' }), foregroundStyle(colors.muted), lineLimit(1), truncationMode('middle')]}>
          {displayAddress(server.url)}
        </Text>
        <Text modifiers={[font({ textStyle: 'footnote' }), foregroundStyle(colors.muted), lineLimit(1)]}>{serverVersion(server.version)}</Text>
      </VStack>
      <Spacer minLength={8} />
      <Button label="Change" onPress={onChange} modifiers={[buttonStyle('borderless'), tint(colors.accent), accessibilityLabel('Change server')]} />
    </HStack>
  </Section>;
}

const styles = StyleSheet.create({
  page: { flex: 1 },
});
