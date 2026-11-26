import type { Artwork, TrackSummary } from '@squirmy/contracts';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useCanPlay } from '../../downloads/DownloadsProvider';
import { useLiked } from '../../data/library';
import { fadedText } from '../../faded';
import { spokenDuration, trackDuration } from '../../library/duration';
import { useCurrentTrackState } from '../../playback';
import { TvButton, tvColors } from '../ui';
import { BrowseArt } from './view';

export function BrowseRow({ title, subtitle, artworks, glyph, round, detail, label, dim, selected, onPress, onMenu }: {
  title: string; subtitle?: string; artworks?: readonly Artwork[]; glyph?: string; round?: boolean; detail?: string;
  label?: string; dim?: boolean; selected?: boolean; onPress: () => void; onMenu?: () => void;
}) {
  const [focused, setFocused] = useState(false);
  const text = focused ? tvColors.ink : dim ? fadedText.dark.title : tvColors.text;
  const secondary = focused ? tvColors.ink : dim ? fadedText.dark.title : tvColors.muted;
  return <View style={styles.row}>
    <Pressable accessibilityRole="button" accessibilityLabel={label ?? [title, subtitle, detail].filter(Boolean).join(', ')}
      accessibilityState={{ selected }} onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}
      onPress={onPress} onLongPress={onMenu} style={[styles.cell, selected && styles.selected, focused && styles.focused]}>
      {artworks?.length || glyph
        ? <BrowseArt artworks={artworks} size={54} glyph={glyph} round={round} dim={dim && !focused} />
        : null}
      <View style={styles.labels}>
        <Text numberOfLines={1} style={[styles.title, { color: text }]}>{title}</Text>
        {!!subtitle && <Text numberOfLines={1} style={[styles.subtitle, { color: secondary }]}>{subtitle}</Text>}
      </View>
      {!!detail && <Text style={[styles.detail, { color: secondary }]}>{detail}</Text>}
    </Pressable>
    {onMenu && <TvButton label="…" accessibilityLabel={`More for ${title}`} onPress={onMenu} tone="surface" style={styles.menu} />}
  </View>;
}

export function BrowseTrackRow({ track, position, kind, play, onMenu }: {
  track: TrackSummary; position?: number; kind?: string; play: () => void; onMenu: () => void;
}) {
  const playable = useCanPlay(track);
  const current = useCurrentTrackState(track.id);
  const liked = useLiked('track', track.id, track.liked);
  const status = !playable ? 'Not available' : current === 'playing' ? 'Playing' : current === 'paused' ? 'Paused' : undefined;
  const duration = trackDuration(track.durationMs);
  const label = [track.title, track.artistCredit, track.explicit && 'Explicit', liked && 'Liked',
    kind, status, spokenDuration(track.durationMs)].filter(Boolean).join(', ');
  const detail = [liked && '♥', status ?? duration].filter(Boolean).join('   ');
  const artwork = position === undefined ? track.album?.artwork : null;
  return <BrowseRow title={track.title + (track.explicit ? '  ▪' : '')} subtitle={[kind, track.artistCredit].filter(Boolean).join(' · ')}
    artworks={artwork ? [artwork] : undefined} glyph={position === undefined ? '♪' : String(position)} detail={detail}
    label={label} selected={!!current} dim={!playable} onPress={playable ? play : onMenu} onMenu={onMenu} />;
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, marginVertical: 3 },
  cell: {
    flex: 1, minHeight: 76, flexDirection: 'row', alignItems: 'center', gap: 19,
    paddingVertical: 9, paddingHorizontal: 14, borderRadius: 14,
    borderWidth: 1, borderColor: 'transparent',
  },
  selected: { borderColor: tvColors.border, backgroundColor: tvColors.surface },
  focused: { backgroundColor: tvColors.accent, borderColor: tvColors.accent },
  labels: { flex: 1, gap: 3 },
  title: { fontSize: 23, fontWeight: '600', lineHeight: 28 },
  subtitle: { fontSize: 17, lineHeight: 22 },
  detail: { fontSize: 18, fontVariant: ['tabular-nums'], marginRight: 8 },
  menu: { width: 70, alignSelf: 'stretch' },
});
