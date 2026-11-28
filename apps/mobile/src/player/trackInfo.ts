import { signalSections, type TrackInfoSection } from '@squirmy/client-core';
import type { SignalPath } from '@squirmy/contracts';
import type { DeviceRow } from './session';

type Where = {
  signal: SignalPath | null;
  /** The device the session plays on, as the devices sheet names it; null with none. */
  output: Pick<DeviceRow, 'name' | 'isThisDevice'> | null;
};

/**
 * Track info's sections, the same on the phone and the TV: where the song plays, then what that
 * device says of the file, the stream and normalization (client-core's `signalSections`).
 */
export function trackInfoSections({ signal, output }: Where): TrackInfoSection[] {
  const where: TrackInfoSection[] = output ? [{ title: 'Playing on', rows: [{ label: 'Device', value: output.name }] }] : [];
  return [...where, ...(signal ? signalSections(signal) : [])];
}

/** Why Track info has nothing to say of the audio, when it has not; null when it has. */
export function trackInfoNote({ signal, output }: Where): string | null {
  if (signal) return null;
  if (!output) return 'Play the song to see how it plays.';
  if (output.isThisDevice) return 'Loading the song…';
  return `${output.name} hasn’t said how it plays this song. It may need an update.`;
}
