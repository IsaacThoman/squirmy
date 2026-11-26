import { formatDuration } from '@squirmy/client-core';
import { useCallback, useState } from 'react';
import { Pressable, StyleSheet, Text, TVFocusGuideView, useTVEventHandler, View } from 'react-native';
import { usePlaybackActions, usePositionEvery } from '../../playback';
import { tvColors } from '../ui';

const seekStepMs = 10_000;
const seekSteps: Readonly<Partial<Record<string, number>>> = {
  left: -seekStepMs,
  right: seekStepMs,
  swipeLeft: -seekStepMs,
  swipeRight: seekStepMs,
  longLeft: -60_000,
  longRight: 60_000,
};

/** Select to set a preview position with the remote's arrows, then select again to seek. */
export function TvScrubber({ duration, disabled }: { duration: number; disabled: boolean }) {
  const position = usePositionEvery(250);
  const { seek } = usePlaybackActions();
  const [focused, setFocused] = useState(false);
  const [preview, setPreview] = useState<number | null>(null);
  const shown = Math.min(duration, Math.max(0, preview ?? position));
  const adjusting = preview !== null;
  const seekable = !disabled && duration > 0;
  const progress = duration > 0 ? shown / duration : 0;
  const clamp = useCallback((value: number) => Math.max(0, Math.min(duration, value)), [duration]);

  useTVEventHandler(useCallback<Parameters<typeof useTVEventHandler>[0]>(event => {
    if (!focused || !adjusting || !seekable || String(event.eventKeyAction) === '0') return;
    const step = seekSteps[event.eventType];
    if (step) setPreview(previous => previous === null ? null : clamp(previous + step));
  }, [adjusting, clamp, focused, seekable]));

  const select = () => {
    if (adjusting) {
      seek(shown);
      setPreview(null);
    } else {
      setPreview(shown);
    }
  };

  return (
    <TVFocusGuideView trapFocusLeft={adjusting} trapFocusRight={adjusting}>
      <Pressable
        accessibilityRole="adjustable"
        accessibilityLabel="Playback position"
        accessibilityHint={adjusting ? 'Select again to seek' : 'Select to seek'}
        accessibilityValue={{ text: `${formatDuration(shown)} of ${formatDuration(duration)}` }}
        accessibilityActions={[{ name: 'decrement', label: 'Back 10 seconds' }, { name: 'increment', label: 'Forward 10 seconds' }]}
        onAccessibilityAction={({ nativeEvent }) => {
          if (!seekable) return;
          if (nativeEvent.actionName === 'increment') seek(clamp(shown + seekStepMs));
          if (nativeEvent.actionName === 'decrement') seek(clamp(shown - seekStepMs));
        }}
        disabled={!seekable}
        tvParallaxProperties={{ enabled: false }}
        onPress={select}
        onFocus={() => setFocused(true)}
        onBlur={() => { setFocused(false); setPreview(null); }}
        style={[styles.scrubber, focused && styles.focused, adjusting && styles.adjusting]}
      >
        <View style={styles.track}>
          <View style={[styles.fill, { width: `${progress * 100}%` }]} />
          {focused && <View style={[styles.thumb, { left: `${progress * 100}%` }]} />}
        </View>
        <View style={styles.times}>
          <Text style={[styles.time, focused && styles.focusText]}>{formatDuration(shown)}</Text>
          {focused && <Text style={styles.hint}>{adjusting ? '←  10 seconds  →    ·    Select to seek' : 'Select to seek'}</Text>}
          <Text style={[styles.time, focused && styles.focusText]}>{formatDuration(duration)}</Text>
        </View>
      </Pressable>
    </TVFocusGuideView>
  );
}

const styles = StyleSheet.create({
  scrubber: { padding: 15, marginHorizontal: -15, borderRadius: 15, borderColor: 'transparent', borderWidth: 2, gap: 12 },
  focused: { borderColor: '#FFFFFF8C', backgroundColor: '#FFFFFF12' },
  adjusting: { borderColor: tvColors.accent, backgroundColor: '#CBC1FF1A' },
  track: { height: 7, borderRadius: 4, backgroundColor: '#FFFFFF44', justifyContent: 'center' },
  fill: { position: 'absolute', left: 0, top: 0, bottom: 0, borderRadius: 4, backgroundColor: tvColors.accent },
  thumb: { position: 'absolute', width: 15, height: 15, borderRadius: 8, marginLeft: -7, backgroundColor: tvColors.text },
  times: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  time: { color: tvColors.muted, fontSize: 20, fontVariant: ['tabular-nums'], fontWeight: '600' },
  focusText: { color: tvColors.text },
  hint: { color: tvColors.accent, fontSize: 18, textAlign: 'center', flexShrink: 1 },
});
