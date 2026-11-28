import { audioQualityLabel, signalQuality, type TrackInfoSection } from '@squirmy/client-core';
import type { SignalPath } from '@squirmy/contracts';
import { BlurView } from 'expo-blur';
import { useIsFocused, useRouter } from 'expo-router';
import { useEffect, useRef } from 'react';
import { Animated, StyleSheet, Text, View } from 'react-native';
import { usePlaybackState } from '../../playback';
import { trackInfoNote, trackInfoSections } from '../../player/trackInfo';
import { Icon } from '../../ui';
import { Button } from '../Button';
import { colors, type } from '../theme';
import { useMenuKey } from './useMenuKey';

const panelWidth = 1120;

/**
 * Track info, in a glass panel at the side of the screen as the devices panel opens: the song,
 * where it plays, its file, how it reaches that device and the normalization applied, in two
 * columns so it fits without scrolling (the remote scrolls only between focusable things).
 * The song's menu in Now Playing opens it; Menu or Done closes it.
 */
export function TrackInfoScreen() {
  const { track, signal, output, session } = usePlaybackState();
  const router = useRouter();
  useMenuKey(useIsFocused(), () => router.back());
  const appear = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.spring(appear, { toValue: 1, speed: 14, bounciness: 0, useNativeDriver: true }).start();
  }, [appear]);
  const where = { signal, output: session.activeDeviceId ? output : null };
  const sections = trackInfoSections(where);
  const note = trackInfoNote(where);
  // The file beside where it plays, then the stream and normalization: two columns of about the same height.
  const columns = [sections.slice(0, 2), sections.slice(2)];

  return <View style={styles.screen}>
    <Animated.View style={[styles.dim, { opacity: appear }]} />
    <Animated.View style={[styles.panel, { opacity: appear, transform: [{ translateX: appear.interpolate({ inputRange: [0, 1], outputRange: [80, 0] }) }] }]}>
      <BlurView tint="dark" intensity={90} style={StyleSheet.absoluteFill} />
      <View style={styles.wash} />
      <View style={styles.content}>
        <Text accessibilityRole="header" style={styles.title}>Track info</Text>
        <Text numberOfLines={1} style={styles.subtitle}>{track ? [track.title, track.artistCredit, track.album?.title].filter(Boolean).join(' · ') : 'Not Playing'}</Text>
        <View style={styles.columns}>
          {columns.map((column, index) => <View key={index} style={styles.column}>
            {column.map(section => <Section key={section.title} section={section} />)}
          </View>)}
        </View>
        {note && <Text style={styles.note}>{note}</Text>}
        <View style={styles.done}><Button label="Done" hasTVPreferredFocus onPress={() => router.back()} /></View>
      </View>
    </Animated.View>
  </View>;
}

function Section({ section }: { section: TrackInfoSection }) {
  return <View accessible accessibilityLabel={[section.title, ...section.rows.map(row => `${row.label}, ${row.value}`)].join('. ')} style={styles.section}>
    <Text style={styles.sectionTitle}>{section.title}</Text>
    {section.rows.map(row => <View key={row.label} style={styles.row}>
      <Text style={styles.label}>{row.label}</Text>
      <Text numberOfLines={2} style={styles.value}>{row.value}</Text>
    </View>)}
  </View>;
}

/** "Lossless" or "Hi-Res Lossless" under Now Playing's titles, as the system's music app badges it; nothing for a lossy stream. */
export function QualityBadge({ signal }: { signal: SignalPath | null }) {
  const quality = signalQuality(signal);
  if (!quality) return null;
  return <View accessible accessibilityLabel={audioQualityLabel(quality)} style={styles.badge}>
    <Icon name="waveform" size={20} color={colors.secondary} />
    <Text style={styles.badgeText}>{audioQualityLabel(quality)}</Text>
  </View>;
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  dim: { ...StyleSheet.absoluteFill, backgroundColor: 'rgba(0,0,0,0.45)' },
  panel: { position: 'absolute', top: 60, bottom: 60, right: 60, width: panelWidth, borderRadius: 44, overflow: 'hidden' },
  wash: { ...StyleSheet.absoluteFill, backgroundColor: 'rgba(40,36,54,0.35)' },
  content: { flex: 1, padding: 44 },
  title: { ...type.title2 },
  subtitle: { ...type.body, color: colors.secondary, marginTop: 6 },
  columns: { flexDirection: 'row', gap: 56, marginTop: 34 },
  column: { flex: 1, gap: 34 },
  section: { gap: 4 },
  sectionTitle: { ...type.headline, fontSize: 29, color: colors.secondary, marginBottom: 6 },
  row: { flexDirection: 'row', justifyContent: 'space-between', gap: 24, paddingVertical: 6, borderBottomWidth: 1, borderColor: colors.hairline },
  label: { ...type.caption, color: colors.secondary },
  value: { ...type.caption, color: colors.text, flexShrink: 1, textAlign: 'right' },
  note: { ...type.body, color: colors.secondary, marginTop: 30 },
  done: { position: 'absolute', left: 44, bottom: 44 },
  badge: {
    flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 12, paddingHorizontal: 12, paddingVertical: 4,
    borderRadius: 8, borderWidth: 2, borderColor: colors.tertiary,
  },
  badgeText: { ...type.footnote, fontWeight: '700', color: colors.secondary },
});
