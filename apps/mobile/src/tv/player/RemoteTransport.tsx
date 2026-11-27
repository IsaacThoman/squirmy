import { useRef } from 'react';
import { useTVEventHandler } from 'react-native';
import { usePlaybackActions } from '../../playback';

/** A press can arrive as its down and its up; one toggle per press. */
const pressGapMs = 300;

/**
 * The Siri Remote's play/pause button plays and pauses anywhere in the app, as it does in the
 * system's music app. Now Playing's own controls handle the rest of the remote.
 */
export function RemoteTransport() {
  const actions = usePlaybackActions();
  const latest = useRef(actions);
  latest.current = actions;
  const last = useRef(0);
  useTVEventHandler(event => {
    if (event.eventType !== 'playPause') return;
    const now = Date.now();
    if (now - last.current < pressGapMs) return;
    last.current = now;
    latest.current.playPause();
  });
  return null;
}
