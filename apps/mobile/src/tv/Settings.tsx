import type { ScrobbleService } from '@squirmy/contracts';
import Constants from 'expo-constants';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useState, type ReactNode } from 'react';
import { ActivityIndicator, Alert, ScrollView, StyleSheet, Text, View } from 'react-native';
import { BrandMark } from '../BrandMark';
import { displayAddress } from '../account/address';
import { unsavedSignIn, useAccount } from '../account/AccountProvider';
import { serviceNames } from '../account/scrobbling';
import {
  lastFmAdminNote, normalizationNote, normalizationOptions, qualityOptions, saveFailure, scrobbleDetail, scrobbleFooter,
  serverMusicLabel, serverMusicNote, useSettingsScreen,
} from '../account/settings';
import { loadFailure } from '../data/errors';
import { useUpdateSettings, useUserSettings } from '../data/queries';
import { useDownloadActions } from '../downloads/DownloadsProvider';
import { Icon } from '../ui';
import { Focusable } from './Focusable';
import { Menu, type MenuAction } from './Menu';
import { Backdrop, PageState } from './Page';
import {
  appVersion, canToggleScrobbling, choiceSpec, isChoice, onOff, optionLabel, scrobbleValue, serverVersionValue, tvQualityNote, type Choice,
} from './settingsModel';
import { colors, tv, type } from './theme';
import { TabRoot } from './Sidebar';

/** What the screen says about scrobbling, as the TV can't open the services' sign-in pages. */
const connectElsewhere = 'Connect ListenBrainz or Last.fm in Squirmy on your iPhone or in the web app. Once connected, what you play on Apple TV is sent too.';

/**
 * The system's Settings layout: the app's mark on the left with a word about the focused row
 * under it, and the rows on the right, in sections. Menu goes back as everywhere.
 */
function SettingsLayout({ title, note, root, children }: { title: string; note: string | null; root?: boolean; children: ReactNode }) {
  const page = <View style={styles.page}>
    <Backdrop />
    <Text accessibilityRole="header" style={styles.title}>{title}</Text>
    <View style={styles.columns}>
      <View style={styles.aside}>
        <View style={styles.mark}><BrandMark size={380} /></View>
        <Text style={styles.note}>{note ?? ''}</Text>
      </View>
      <ScrollView style={styles.list} contentContainerStyle={styles.listContent} showsVerticalScrollIndicator={false}>
        {children}
      </ScrollView>
    </View>
  </View>;
  // The tab's first page carries the sidebar; a choice pushed over it does not.
  return root ? <TabRoot>{page}</TabRoot> : page;
}

type RowProps = {
  title: string;
  /** The current value, on the right in gray. */
  value?: string;
  /** Selecting opens a list of choices. */
  chevron?: boolean;
  /** The chosen one in a list of choices. */
  checked?: boolean;
  /** Shown under the mark while the row is focused. */
  note?: string;
  onNote: (note: string | null) => void;
  onPress?: () => void;
  /** Held, the row opens these, as the system's long-press menus do. */
  menu?: { actions: MenuAction[]; onAction: (id: string) => void };
  hasTVPreferredFocus?: boolean;
};

/**
 * A row as in the system's Settings: a frosted platter with the setting on the left and its
 * value on the right, which turns white with dark ink when focused. A row without an action is
 * still focusable, so focus can reach it and its note.
 */
function Row({ title, value, chevron, checked, note, onNote, onPress, menu, hasTVPreferredFocus }: RowProps) {
  const row = <Focusable
    accessibilityRole={onPress ? 'button' : 'text'}
    accessibilityLabel={value ? `${title}, ${value}` : title}
    accessibilityState={checked === undefined ? undefined : { selected: checked }}
    onPress={onPress}
    hasTVPreferredFocus={hasTVPreferredFocus}
    onFocusChange={focused => { if (focused) onNote(note ?? null); }}
    scale={1.025}
    style={styles.rowBox}
    liftStyle={({ focused }) => [styles.row, focused && styles.rowFocused]}
  >
    {({ focused }) => <>
      <Text numberOfLines={2} style={[styles.rowTitle, focused && styles.inkFocused]}>{title}</Text>
      {value ? <Text numberOfLines={1} style={[styles.value, focused && styles.valueFocused]}>{value}</Text> : null}
      {checked && <Icon name="checkmark" size={30} color={focused ? colors.onFocused : colors.accent} />}
      {chevron && <Icon name="chevron.right" size={24} color={focused ? valueFocused : colors.tertiary} />}
    </>}
  </Focusable>;
  return menu ? <Menu actions={menu.actions} onAction={menu.onAction} title={title}>{row}</Menu> : row;
}

function Section({ title, footer, error, children }: { title?: string; footer?: string | null; error?: string | null; children: ReactNode }) {
  return <View style={styles.section}>
    {title ? <Text accessibilityRole="header" style={styles.sectionTitle}>{title}</Text> : null}
    <View style={styles.rows}>{children}</View>
    {error ? <Text style={[styles.footer, styles.error]}>{error}</Text> : null}
    {footer ? <Text style={styles.footer}>{footer}</Text> : null}
  </View>;
}

/** Settings: the account, playback, the library's switch, scrobbling and the app's version. */
export function TvSettingsScreen() {
  const router = useRouter();
  const { state, unsaved, signOut, switchServer } = useAccount();
  const { removeAll } = useDownloadActions();
  const screen = useSettingsScreen();
  const [note, setNote] = useState<string | null>(null);
  if (state.status !== 'signedIn') return null;
  const { server, user } = state;
  const { settings } = screen;
  const name = user.displayName ?? user.username;
  const role = user.role === 'admin' ? 'Admin' : 'Member';

  const confirm = (title: string, message: string, action: string, perform: () => void) => {
    Alert.alert(title, message, [
      { text: 'Cancel', style: 'cancel' },
      // Downloads belong to this account on this server, so leaving removes any, as on the phone.
      { text: action, style: 'destructive', onPress: () => { removeAll(); perform(); } },
    ]);
  };
  const open = (choice: Choice) => router.push(`/settings/${choice}`);

  return <SettingsLayout title="Settings" note={note} root>
    <Section title="Account" error={unsaved ? unsavedSignIn : null}>
      <Row title={name} value={role} onNote={setNote} hasTVPreferredFocus
        note={user.displayName ? `Signed in as ${user.username}.` : `Signed in to ${server.name}.`} />
      <Row title="Server" value={server.name} onNote={setNote} note={displayAddress(server.url)} />
      {/* Worded as on the TV's sign-in screen. */}
      <Row title="Change Server" onNote={setNote} note="Sign out and connect to another Squirmy server."
        onPress={() => confirm('Change server?', `You’ll be signed out of ${server.name}.`, 'Change Server', switchServer)} />
      <Row title="Sign Out" onNote={setNote} note={`Sign out of ${server.name} on this Apple TV.`}
        onPress={() => confirm(`Sign out of ${server.name}?`, 'You can sign back in at any time.', 'Sign Out', signOut)} />
    </Section>

    {settings ? <>
      <Section title="Playback" error={screen.errors.playback}>
        <Row title="Volume Normalization" value={optionLabel(normalizationOptions, settings.normalization)} chevron
          note={normalizationNote} onNote={setNote} onPress={() => open('normalization')} />
        <Row title="Streaming Quality" value={optionLabel(qualityOptions, settings.qualityWifi)} chevron
          note={tvQualityNote} onNote={setNote} onPress={() => open('quality')} />
      </Section>
      <Section title="Library" error={screen.errors.library}>
        <Row title={serverMusicLabel} value={onOff(settings.libraryIncludesServerMusic)} note={serverMusicNote} onNote={setNote}
          onPress={() => screen.setLibraryIncludesServerMusic(!settings.libraryIncludesServerMusic)} />
      </Section>
    </> : <Section title="Playback">
      {screen.settingsFailure
        ? <Row title="Couldn’t load your settings" value={screen.settingsFailure.retry ? 'Try again' : undefined}
          note={screen.settingsFailure.description} onNote={setNote} onPress={screen.settingsFailure.retry ?? undefined} />
        : <View style={styles.loading}><ActivityIndicator color={colors.secondary} /></View>}
    </Section>}

    <Scrobbling screen={screen} onNote={setNote} />

    <Section title="About">
      <Row title="Squirmy for Apple TV" value={appVersion(Constants.expoConfig?.version, Constants.platform?.ios?.buildNumber)}
        note="The version of this app, for bug reports." onNote={setNote} />
      <Row title="Server Version" value={serverVersionValue(server.version)} note={`${server.name}, at ${displayAddress(server.url)}.`} onNote={setNote} />
    </Section>
  </SettingsLayout>;
}

type Screen = ReturnType<typeof useSettingsScreen>;

/**
 * Each service's state, and its switch once connected. Connecting needs the service's web
 * sign-in or a pasted token, which belong on the phone or the web; holding a connected row
 * offers Disconnect.
 */
function Scrobbling({ screen, onNote }: { screen: Screen; onNote: (note: string | null) => void }) {
  const services = [screen.listenBrainz, screen.lastFm].filter((service): service is ScrobbleService => Boolean(
    service && (service.available || service.connected),
  ));
  const lastFmMissing = screen.lastFm && !screen.lastFm.available && !screen.lastFm.connected && screen.isAdmin;
  // Settings' own failure says it already; the connections have one only when they fail alone.
  if (screen.scrobblingFailure && !screen.settingsFailure) {
    const failure = screen.scrobblingFailure;
    return <Section title="Scrobbling">
      <Row title="Couldn’t load scrobbling" value={failure.retry ? 'Try again' : undefined} note={failure.description} onNote={onNote}
        onPress={failure.retry ?? undefined} />
    </Section>;
  }
  if (!services.length) return null;
  const error = screen.errors.listenbrainz ?? screen.errors.lastfm;
  return <Section title="Scrobbling" error={error} footer={[connectElsewhere, lastFmMissing ? lastFmAdminNote : null].filter(Boolean).join('\n\n')}>
    {services.map(service => {
      const enabled = screen.scrobbleEnabled(service);
      const toggle = canToggleScrobbling(service) ? () => screen.setScrobbling(service.target, !enabled) : undefined;
      const menu = toggle ? {
        actions: [
          { id: 'toggle', title: enabled ? 'Turn Off Scrobbling' : 'Turn On Scrobbling', image: enabled ? 'pause.circle' : 'play.circle' },
          { id: 'disconnect', title: 'Disconnect', image: 'xmark', destructive: true },
        ],
        onAction: (id: string) => id === 'toggle' ? toggle() : screen.disconnect(service.target),
      } : undefined;
      return <Row key={service.target} title={serviceNames[service.target]} value={scrobbleValue(service, enabled)} onNote={onNote}
        note={`${scrobbleDetail(service)}.\n\n${toggle ? scrobbleFooter(service, enabled) : connectElsewhere}`} onPress={toggle} menu={menu} />;
    })}
  </Section>;
}

/** A list of choices for one setting, opened from Settings. Choosing one saves it and goes back. */
export function TvSettingsChoiceScreen() {
  const router = useRouter();
  const { choice } = useLocalSearchParams<{ choice: string }>();
  const settings = useUserSettings();
  const update = useUpdateSettings();
  const [error, setError] = useState<string | null>(null);
  if (!isChoice(choice)) return <PageState message="There’s no such setting." />;
  if (!settings.data) return settings.isError ? <PageState message={loadFailure(settings.error).description} onRetry={() => void settings.refetch()} /> : <PageState loading />;
  const spec = choiceSpec(choice, normalizationOptions, qualityOptions, normalizationNote);
  const current = spec.current(settings.data);
  const choose = (value: string) => {
    setError(null);
    if (value === current) return router.back();
    // The check moves at once; the list closes once the server has it, or says why it didn't.
    update.mutate(spec.change(value), { onSuccess: () => router.back(), onError: failure => setError(saveFailure(failure)) });
  };
  return <SettingsLayout title={spec.title} note={spec.note}>
    <Section error={error}>
      {spec.options.map(option => <Row key={option.value} title={option.label} checked={option.value === current}
        hasTVPreferredFocus={option.value === current} onNote={() => undefined} onPress={() => choose(option.value)} />)}
    </Section>
  </SettingsLayout>;
}

const asideWidth = 760;
/** A value's ink on a focused row: the dark ink, quieter. */
const valueFocused = 'rgba(17,16,24,0.62)';

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.background },
  title: { ...type.title2, textAlign: 'center', marginTop: tv.top, marginBottom: 24, marginHorizontal: 360 },
  columns: { flex: 1, flexDirection: 'row' },
  aside: { width: asideWidth, marginLeft: tv.gutter, alignItems: 'center', paddingTop: 120 },
  mark: { borderRadius: 84, shadowColor: colors.shadow, shadowOpacity: 0.5, shadowRadius: 40, shadowOffset: { width: 0, height: 24 } },
  note: { ...type.body, color: colors.secondary, textAlign: 'center', marginTop: 56, maxWidth: 620, lineHeight: 40 },
  list: { flex: 1, overflow: 'visible' },
  // Room at the sides for a focused row to grow into.
  listContent: { paddingLeft: 80, paddingRight: tv.gutter + 20, paddingTop: 40, paddingBottom: 160 },
  section: { marginBottom: 48 },
  sectionTitle: { ...type.caption, fontSize: 27, fontWeight: '600', marginLeft: 32, marginBottom: 14 },
  rows: { gap: 10 },
  rowBox: { alignSelf: 'stretch' },
  row: {
    flexDirection: 'row', alignItems: 'center', gap: 20, minHeight: 76, paddingHorizontal: 32, paddingVertical: 14,
    borderRadius: 14, backgroundColor: colors.platter,
  },
  rowFocused: { backgroundColor: colors.focused },
  rowTitle: { ...type.callout, flex: 1 },
  inkFocused: { color: colors.onFocused },
  value: { ...type.callout, fontWeight: '400', color: colors.secondary, maxWidth: 420, textAlign: 'right' },
  valueFocused: { color: valueFocused },
  footer: { ...type.footnote, color: colors.secondary, marginTop: 16, marginHorizontal: 32, lineHeight: 32 },
  error: { color: colors.danger, fontWeight: '600' },
  loading: { minHeight: 76, alignItems: 'center', justifyContent: 'center' },
});
