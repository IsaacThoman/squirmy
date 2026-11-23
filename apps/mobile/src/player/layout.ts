import { displayFontScale, secondaryFontScale } from '../fontScale';

/**
 * The height of Now Playing's title and artist at the system text size: two lines of 30 pt
 * title, as a long one wraps, and two of the 16 pt artist credit, as a featured artist makes
 * it long, each growing up to its cap. The artwork is sized to leave this free whatever lines
 * they take, so it stays put from one song to the next.
 */
export function metadataHeight(fontScale: number) {
  const title = 2 * 36 * Math.min(fontScale, displayFontScale);
  const artist = 3 + 2 * 20 * Math.min(fontScale, secondaryFontScale);
  return Math.ceil(title + artist);
}

/**
 * The height of the line under Now Playing's grabber that says what is playing from
 * ("Playing from album · Dummy"), as on web: an 11 pt heading over a 13 pt title, growing up
 * to the secondary cap. Its room is kept when there is nothing to say, so the artwork does
 * not move from one song to the next.
 */
export function contextHeight(fontScale: number) {
  return Math.max(34, Math.ceil(31 * Math.min(fontScale, secondaryFontScale)));
}
