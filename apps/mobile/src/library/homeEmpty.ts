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
      icon: 'arrow.triangle.2.circlepath', title: 'Scanning music', findMusic: false,
      description: `${scan.processed.toLocaleString()} of ${scan.total.toLocaleString()} files read. Albums appear as they’re scanned.`,
    };
  }
  if (canFindMusic) {
    return {
      icon: 'music.note.house', title: 'Start listening', findMusic: true,
      description: 'Search for a song, album or artist. Recent plays and music you save show up here.'
        + (isAdmin ? ' Music folders are added from Admin in Squirmy on the web.' : ''),
    };
  }
  return {
    icon: 'music.note.house', title: 'No music on this server yet', findMusic: false,
    description: isAdmin
      ? 'Add a music folder from Admin in Squirmy on the web. Albums appear as they’re scanned.'
      : 'Albums appear here after a server admin adds and scans a music folder.',
  };
}
