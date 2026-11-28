import { hasVersions, versionDetail, versionQuality, versionSongs, versionTitle } from '@squirmy/client-core';
import type { AlbumDetail } from '@squirmy/contracts';
import type { AlbumNavProps } from './AlbumButtons';

type Album = Pick<AlbumDetail, 'title' | 'ownedVersions' | 'versionId'>;

/** What a pick the server refused says, on the Versions button and to VoiceOver. */
export function versionFailure(title: string): string {
  return `Couldn’t change the version of “${title}”. Try again.`;
}

/**
 * The album page's Versions button, while the server holds two versions of the album or more
 * (client-core's `hasVersions`), false otherwise. Its menu, worded as on web: Automatic (the
 * album's own edition, each song from its best copy), then each version with its quality, how
 * many songs it has and the release's facts. The user's pick is checked, and choosing it again
 * does nothing; a pick the server no longer holds counts as Automatic, as the server does.
 * `choose` takes null for Automatic. `busy`: a pick is on its way; `failed`: the server refused
 * the last one.
 */
export function versionsButton(album: Album, { busy, failed }: { busy: boolean; failed: boolean },
  choose: (versionId: string | null) => void): AlbumNavProps | false {
  if (!hasVersions(album)) return false;
  const versions = album.ownedVersions!;
  const picked = versions.find(version => version.id === album.versionId);
  const pick = (versionId: string | null) => () => {
    if (versionId !== (picked?.id ?? null)) choose(versionId);
  };
  return {
    icon: failed ? 'exclamationmark.circle' : 'square.stack', busy, failed,
    label: failed ? versionFailure(album.title) : `Versions of ${album.title}, ${picked ? versionTitle(picked) : 'Automatic'}`,
    choices: [
      { heading: 'Plays by default', options: [{ id: 'automatic', title: 'Automatic', subtitle: 'The best copy of each song', checked: !picked, onPress: pick(null) }] },
      {
        options: versions.map(version => ({
          id: version.id,
          title: versionTitle(version),
          subtitle: [`${versionQuality(version.quality)} · ${versionSongs(version)}`, versionDetail(version)].filter(Boolean).join('\n'),
          checked: version === picked,
          onPress: pick(version.id),
        })),
      },
    ],
  };
}
