import { displayFontScale, secondaryFontScale } from '../fontScale';

/**
 * The height of Now Playing's title and artist lines at the system text size: a 30 pt title
 * and a 16 pt artist line, each growing up to its cap. The artwork is sized to leave this free.
 */
export function metadataHeight(fontScale: number) {
  const title = 36 * Math.min(fontScale, displayFontScale);
  const artist = 3 + 20 * Math.min(fontScale, secondaryFontScale);
  return Math.max(60, Math.ceil(title + artist));
}
