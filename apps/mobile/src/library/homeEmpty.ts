import { plural } from '@squirmy/client-core';
import type { ScanProgress } from '../data/scanProgress';

export type HomeEmpty = { icon: string; title: string; description: string; findMusic: boolean };

/**
 * What an empty Home says, by web's rule: a scan under way says how far it has come (only
 * admins are told); someone the server fetches music for is sent to Search; anyone else is
 * told where music comes from. Web's Add a music folder is an admin page this app does not
 * have, so for an admin it is a sentence instead.
 */
export function homeEmpty({ canFindMusic, isAdmin, scan }: { canFindMusic: boolean; isAdmin: boolean; scan: ScanProgress | null }): HomeEmpty {
  if (scan) {
    return {
      icon: 'arrow.triangle.2.circlepath', title: 'Your music is on its way', findMusic: false,
      description: `Scanning: ${plural(scan.processed, 'file')} of ${scan.total.toLocaleString()} read. Albums appear here as soon as they are ready.`,
    };
  }
  if (canFindMusic) {
    return {
      icon: 'music.note.house', title: 'Start listening', findMusic: true,
      description: 'Search for any artist, album or song and play it. What you play and add to your library shows up here.'
        + (isAdmin ? ' Music folders are added from Admin in Squirmy on the web.' : ''),
    };
  }
  return {
    icon: 'music.note.house', title: 'Nothing in your library yet', findMusic: false,
    description: isAdmin
      ? 'Add the folder that holds your music from Admin in Squirmy on the web. Albums show up here as they are scanned.'
      : 'An admin of this server adds the music folders. Albums show up here as soon as one is scanned.',
  };
}
