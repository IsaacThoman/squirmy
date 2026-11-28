import { signalSections, versionQuality, versionTitle, type TrackInfoSection } from '@squirmy/client-core';
import type { SignalPath, TrackVersions } from '@squirmy/contracts';
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

/** One row of Track info's Versions: Automatic (`versionId` null) or a version of the song. `picked`: the user's pick. */
export type VersionRow = { key: string; versionId: string | null; title: string; subtitle: string; icon: string; picked: boolean };

/** Under Track info's Versions: a pick does not cut into the song playing. */
export const versionsNote = 'Your pick plays the next time the song starts.';

/** What Track info says when the server refused a pick. */
export const versionPickFailure = 'Couldn’t change the version. Try again.';

/**
 * Track info's Versions, for a song the server holds two versions of or more (none otherwise):
 * Automatic, then each version, best first, with its quality. The user's pick for the song is
 * checked, Automatic when there is none (or the server no longer holds it); Automatic says what
 * it plays, the album's pick or the best copy. `albumId` is the album the song plays from: a
 * version on another album names that album. `playing` is the version the device playing
 * says it plays (`SignalPath.source.versionId`).
 */
export function trackVersionRows(data: TrackVersions | undefined, { albumId, playing }: {
  albumId: string | null | undefined; playing: string | null | undefined;
}): VersionRow[] {
  if (!data || data.versions.length < 2) return [];
  const albumPick = data.versions.find(version => version.id === data.albumVersionId);
  const picked = data.versions.find(version => version.id === data.versionId);
  // With no album to tell them from, albums are named when the versions are on more than one.
  const onSeveral = new Set(data.versions.map(version => version.albumId)).size > 1;
  const named = (id: string) => albumId ? id !== albumId : onSeveral;
  return [
    {
      key: 'automatic', versionId: null, title: 'Automatic', icon: 'sparkles', picked: !picked,
      subtitle: albumPick ? `The album’s pick, ${versionTitle(albumPick)}` : 'The best copy',
    },
    ...data.versions.map(version => {
      const now = version.id === playing;
      return {
        key: version.id, versionId: version.id, picked: version === picked,
        title: named(version.albumId) ? `${versionTitle(version)} · ${version.albumTitle}` : versionTitle(version),
        subtitle: now ? `${versionQuality(version.quality)} · Playing now` : versionQuality(version.quality),
        icon: now ? 'speaker.wave.2.fill' : 'square.stack',
      };
    }),
  ];
}
