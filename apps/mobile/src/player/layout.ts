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

/** The screen heights Now Playing's spacing is drawn for: an iPhone SE's, and a 6.1-inch iPhone's (as Apple Music's). */
const shortScreen = 667;
const tallScreen = 852;

export type Rhythm = {
  /** Between the artwork and the title's room. */
  artworkGap: number;
  /** Above the play button's row, below the time labels. */
  buttonsTop: number;
  /** Below the play button's row, above the volume. */
  buttonsBottom: number;
  /** Above the lyrics, device and queue buttons. */
  footerTop: number;
};

/**
 * Now Playing's vertical spacing for a screen this tall, in points: close to Apple Music's
 * on a 6.1-inch iPhone and taller ones, tighter in step with the height on shorter ones, down
 * to an iPhone SE's. The artwork takes whatever height is left, so it grows on a Pro Max.
 */
export function rhythm(screenHeight: number): Rhythm {
  const t = Math.min(1, Math.max(0, (screenHeight - shortScreen) / (tallScreen - shortScreen)));
  const step = (short: number, tall: number) => Math.round(short + (tall - short) * t);
  return { artworkGap: step(8, 16), buttonsTop: step(8, 22), buttonsBottom: step(8, 32), footerTop: step(4, 12) };
}

/** The pane needs room for lyrics and queue actions alongside the playback controls. */
export function tabletPaneWidth(width: number, height: number, fontScale: number): number {
  const playerMinimum = 400;
  const paneMinimum = Math.round(320 + 70 * Math.min(1, Math.max(0, fontScale - 1)));
  if (height < 480 || width < playerMinimum + paneMinimum) return 0;
  return Math.min(680, width - playerMinimum, Math.max(paneMinimum, Math.round(width * 0.46)));
}

/** The largest the iPad's artwork grows: it fills its column, as in Apple Music, up to about a 13-inch iPad's width. */
export const tabletArtworkLimit = 1000;

/** The iPad's artwork: as wide as its column allows, and short enough to leave the title room under it. */
export function tabletArtworkSize(width: number, deckHeight: number, metadata: number): number {
  return Math.max(1, Math.min(tabletArtworkLimit, width - 48, deckHeight - metadata));
}
