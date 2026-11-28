import type { EngineEvent, EngineStatus } from '@squirmy/client-core';
import Constants from 'expo-constants';
import * as Haptics from 'expo-haptics';
import { useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { connectNowPlaying, createPlayerEngine } from '../player/engine';
import { storedEngine } from '../player/engine/setting';
import { createThemedStyles, useColors } from '../theme';
import { Icon } from '../ui';

/** Served by `scripts/engine-tones.mjs`; see the README. */
const tones = {
  a: { title: 'Tone A', detail: '440 Hz · 20 s', file: 'tone-a.m4a', seconds: 20 },
  b: { title: 'Tone B', detail: '660 Hz · 8 s', file: 'tone-b.m4a', seconds: 8 },
  c: { title: 'Tone C', detail: '550 Hz · 8 s', file: 'tone-c.m4a', seconds: 8 },
} as const;
type Tone = keyof typeof tones;

const tonePort = 4800;
// Metro's host is the Mac, which also runs the tone server; on a phone that is its LAN address.
const defaultBase = `http://${Constants.expoConfig?.hostUri?.split(':')[0] ?? 'localhost'}:${tonePort}`;

type LogLine = { id: number; at: number; text: string };

function describe(event: EngineEvent): string {
  switch (event.type) {
    case 'status': return `status  ${event.status.entryId ?? '–'}  ${event.status.state}  ${seconds(event.status.positionMs)}`;
    case 'ended': return `ended   ${event.entryId}`;
    case 'error': return `error   ${event.entryId}  ${event.message}`;
  }
}

function seconds(ms: number) {
  return `${(ms / 1000).toFixed(2)} s`;
}

/**
 * Drives the native `PlayerEngine` directly with quiet test tones, to check every rule of
 * the engine contract by ear and by its event log. Reachable only in development builds.
 */
export function EngineBench() {
  const colors = useColors();
  const styles = useStyles();
  const router = useRouter();
  const { bottom } = useSafeAreaInsets();
  const [base, setBase] = useState(defaultBase);
  const [log, setLog] = useState<LogLine[]>([]);
  const [status, setStatus] = useState<EngineStatus>({ entryId: null, state: 'idle', positionMs: 0 });
  const [lockScreen, setLockScreen] = useState(true);
  const [preloaded, setPreloaded] = useState<string | null>(null);
  const serial = useRef(0);
  const [started] = useState(Date.now);
  const entries = useRef(new Map<string, Tone>());

  const append = (text: string) => setLog(lines => [{ id: ++serial.current, at: Date.now() - started, text }, ...lines].slice(0, 60));
  // The engine Settings chose for this device. The native one is the process's one engine, so
  // the bench drives the same engine as the app does: stop the music before using it.
  const [engine] = useState(() => createPlayerEngine({ onInterrupted: entryId => append(`system paused ${entryId}`) }, storedEngine()));

  useEffect(() => {
    const unsubscribe = engine.subscribe(event => {
      append(describe(event));
      if (event.type === 'ended') setPreloaded(null);
    });
    const timer = setInterval(() => setStatus(engine.getStatus()), 100);
    return () => {
      unsubscribe();
      clearInterval(timer);
      engine.stop();
      engine.dispose?.();
    };
  }, [engine]);

  const url = (tone: Tone) => `${base.replace(/\/+$/, '')}/${tones[tone].file}`;
  const entryFor = (tone: Tone) => {
    const entryId = `${tone}-${++serial.current}`;
    entries.current.set(entryId, tone);
    return entryId;
  };
  const load = (tone: Tone, options: { startMs?: number; autoplay?: boolean; target?: string } = {}) => {
    engine.load({ entryId: entryFor(tone), url: options.target ?? url(tone), startMs: options.startMs ?? 0, autoplay: options.autoplay ?? true, gain: 1 });
  };
  const preload = (tone: Tone) => {
    const entryId = entryFor(tone);
    engine.preload({ entryId, url: url(tone), gain: 0.5 });
    setPreloaded(entryId);
    append(`preload ${entryId} at gain 0.5`);
  };
  const current = status.entryId ? entries.current.get(status.entryId) : undefined;

  useEffect(() => {
    if (!lockScreen) return;
    const remote = (name: string, action: () => void) => () => {
      append(`remote  ${name}`);
      action();
    };
    // The bench is the caller here, so the remote commands drive the engine directly.
    const connection = connectNowPlaying(engine, entryId => {
      const tone = entries.current.get(entryId);
      return tone ? {
        title: tones[tone].title, artist: 'Squirmy engine bench', album: tones[tone].detail,
        artworkUrl: `${base.replace(/\/+$/, '')}/art.png`, durationMs: tones[tone].seconds * 1000,
      } : null;
    }, {
      onPlay: remote('play', () => engine.play()),
      onPause: remote('pause', () => engine.pause()),
      onNext: remote('next', () => load('b')),
      onPrevious: remote('previous', () => engine.seek(0)),
      onSeek: positionMs => remote(`seek ${seconds(positionMs)}`, () => engine.seek(positionMs))(),
    });
    return connection.disconnect;
  }, [base, engine, lockScreen]);

  const actions: { title: string; icon: string; run: () => void; disabled?: boolean }[][] = [
    [
      { title: 'Load A', icon: 'play.fill', run: () => load('a') },
      { title: 'A at 0:12, paused', icon: 'pause.fill', run: () => load('a', { startMs: 12_000, autoplay: false }) },
    ],
    [
      { title: 'Play', icon: 'play.fill', run: () => engine.play() },
      { title: 'Pause', icon: 'pause.fill', run: () => engine.pause() },
    ],
    [
      { title: '−5 s', icon: 'backward.fill', run: () => engine.seek(engine.getStatus().positionMs - 5000) },
      { title: '+5 s', icon: 'forward.fill', run: () => engine.seek(engine.getStatus().positionMs + 5000) },
      {
        title: 'Near end', icon: 'forward.end.fill', disabled: !current,
        run: () => current && engine.seek(tones[current].seconds * 1000 - 2500),
      },
    ],
    [
      { title: 'Preload B', icon: 'text.badge.plus', run: () => preload('b') },
      { title: 'Preload C', icon: 'text.badge.plus', run: () => preload('c') },
      { title: 'Clear', icon: 'xmark', run: () => { engine.preload(null); setPreloaded(null); append('preload cleared'); } },
    ],
    [
      { title: 'Gain 1', icon: 'speaker.wave.3.fill', run: () => engine.setGain(1) },
      { title: 'Gain 0.3', icon: 'speaker.wave.2.fill', run: () => engine.setGain(0.3) },
      { title: 'Gain 0.05', icon: 'speaker.fill', run: () => engine.setGain(0.05) },
    ],
    [
      { title: 'No server', icon: 'xmark.circle.fill', run: () => load('a', { target: 'http://127.0.0.1:9/tone.m4a' }) },
      { title: 'Missing', icon: 'magnifyingglass', run: () => load('a', { target: `${base.replace(/\/+$/, '')}/missing.m4a` }) },
      { title: 'Stop', icon: 'trash', run: () => engine.stop() },
    ],
  ];

  return <ScrollView style={styles.page} contentContainerStyle={[styles.content, { paddingBottom: bottom + 24 }]}
    keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag">
    <View style={styles.header}>
      <View style={styles.flex}>
        <Text accessibilityRole="header" style={styles.title}>Engine bench</Text>
        <Text style={styles.subtitle}>Drives the native PlayerEngine with quiet test tones.</Text>
      </View>
      <Pressable accessibilityRole="button" accessibilityLabel="Close" onPress={() => router.back()} style={styles.close}>
        <Icon name="xmark" size={15} />
      </Pressable>
    </View>

    <View style={styles.card}>
      <Text style={styles.state}>{status.state}</Text>
      <Text style={styles.mono}>{status.entryId ?? 'nothing loaded'} · {seconds(status.positionMs)}</Text>
      <Text style={styles.mono}>preload {preloaded ?? 'none'}</Text>
    </View>

    <View style={styles.card}>
      <Text style={styles.label}>Tone server</Text>
      <TextInput value={base} onChangeText={setBase} autoCapitalize="none" autoCorrect={false} keyboardType="url"
        style={styles.input} placeholderTextColor={colors.quiet} accessibilityLabel="Tone server address" />
      <View style={styles.switchRow}>
        <Text style={styles.label}>Lock screen and Control Center</Text>
        <Switch value={lockScreen} onValueChange={setLockScreen} trackColor={{ true: colors.accent }} />
      </View>
    </View>

    {actions.map((row, index) => <View key={index} style={styles.row}>
      {row.map(action => <Pressable key={action.title} accessibilityRole="button" disabled={action.disabled}
        onPress={() => {
          void Haptics.selectionAsync();
          action.run();
        }}
        style={({ pressed }) => [styles.action, action.disabled && styles.disabled, pressed && styles.pressed]}>
        <Icon name={action.icon} size={16} color={colors.accent} />
        <Text numberOfLines={1} style={styles.actionTitle}>{action.title}</Text>
      </Pressable>)}
    </View>)}

    <View style={styles.card}>
      <View style={styles.switchRow}>
        <Text style={styles.label}>Events</Text>
        <Pressable accessibilityRole="button" onPress={() => setLog([])}><Text style={styles.link}>Clear</Text></Pressable>
      </View>
      {log.length === 0 && <Text style={styles.mono}>Nothing yet.</Text>}
      {log.map(line => <Text key={line.id} style={styles.mono}>{String(line.at).padStart(7)}  {line.text}</Text>)}
    </View>
  </ScrollView>;
}

const useStyles = createThemedStyles(colors => StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.background },
  content: { padding: 22, gap: 12 },
  header: { flexDirection: 'row', alignItems: 'flex-start', gap: 12, marginBottom: 6 },
  flex: { flex: 1, gap: 4 },
  title: { color: colors.text, fontSize: 30, fontWeight: '800', letterSpacing: -1.1 },
  subtitle: { color: colors.muted, fontSize: 14 },
  close: { width: 37, height: 37, borderRadius: 19, backgroundColor: colors.surface, alignItems: 'center', justifyContent: 'center' },
  card: { borderRadius: 16, backgroundColor: colors.surface, padding: 14, gap: 6 },
  state: { color: colors.accent, fontSize: 26, fontWeight: '800', letterSpacing: -0.6 },
  label: { color: colors.text, fontSize: 15, fontWeight: '600' },
  mono: { color: colors.muted, fontSize: 12, fontFamily: 'Menlo' },
  input: { color: colors.text, fontSize: 15, minHeight: 40, borderRadius: 10, paddingHorizontal: 10, backgroundColor: colors.overlay },
  switchRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: 36 },
  row: { flexDirection: 'row', gap: 8 },
  action: { flex: 1, minHeight: 46, borderRadius: 14, backgroundColor: colors.surface, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7, paddingHorizontal: 8 },
  actionTitle: { color: colors.text, fontSize: 14, fontWeight: '600', flexShrink: 1 },
  disabled: { opacity: 0.4 },
  pressed: { opacity: 0.72 },
  link: { color: colors.accent, fontSize: 14, fontWeight: '600' },
}));
