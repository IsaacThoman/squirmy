import { StyleSheet } from 'react-native';

/**
 * The Apple TV app's design tokens, in points on the 1920 × 1080 canvas tvOS lays apps out on.
 * The TV is always dark, so there is one palette. Measurements follow the system's music app:
 * an 80 pt gutter, shelves of 260 pt covers 40 pt apart, gray section titles, and focus that
 * lifts the focused thing toward the viewer rather than outlining it.
 */
export const tv = {
  /** Left and right page margin; content starts here and shelves scroll from here. */
  gutter: 80,
  /** Where a tab's first page begins, under the sidebar's pill (at 60–112). */
  top: 140,
  /** Where a page pushed over a tab's first page begins; it has no pill. */
  pushedTop: 80,
  /** Space between shelves. */
  shelfGap: 64,
  /** Space between tiles on a shelf. */
  tileGap: 40,
  /** A shelf's cover. */
  tile: 260,
  /** Corner radius of a cover; the focus effect keeps it. */
  radius: 12,
  /** How much a focused control (a button, a row) grows. Covers use the system's own lift. */
  focusScale: 1.06,
} as const;

export const colors = {
  /** The page behind everything, a violet-tinted charcoal that the gradient runs between. */
  background: '#14121C',
  backgroundTop: '#1E1A2C',
  backgroundBottom: '#121116',
  /** A resting control or row: frosted white over the page. */
  platter: 'rgba(255,255,255,0.10)',
  platterStrong: 'rgba(255,255,255,0.18)',
  /** A focused control is white with dark ink, as across tvOS. */
  focused: '#FFFFFF',
  onFocused: '#111018',
  text: '#FFFFFF',
  secondary: 'rgba(235,235,245,0.62)',
  tertiary: 'rgba(235,235,245,0.38)',
  /** Section titles: quieter than a page title, as the system's shelves are. */
  sectionTitle: 'rgba(235,235,245,0.62)',
  hairline: 'rgba(255,255,255,0.12)',
  /** Squirmy's violet, for what is playing and for small accents. */
  accent: '#CBC1FF',
  accentStrong: '#9C8CF2',
  danger: '#FF8F87',
  placeholder: '#2A2733',
  shadow: '#000000',
} as const;

/**
 * Type on the TV, after the tvOS text styles (Title 1 76, Title 2 57, Title 3 48, Headline 38,
 * Body 29, Callout 31, Subhead 29, Footnote 23, Caption 25), with the system font.
 */
export const type = StyleSheet.create({
  largeTitle: { fontSize: 76, fontWeight: '700', color: colors.text, letterSpacing: -0.5 },
  title1: { fontSize: 57, fontWeight: '700', color: colors.text, letterSpacing: -0.3 },
  title2: { fontSize: 48, fontWeight: '700', color: colors.text },
  title3: { fontSize: 38, fontWeight: '600', color: colors.text },
  headline: { fontSize: 38, fontWeight: '600', color: colors.text },
  section: { fontSize: 38, fontWeight: '700', color: colors.sectionTitle },
  body: { fontSize: 29, fontWeight: '400', color: colors.text },
  bodyStrong: { fontSize: 29, fontWeight: '600', color: colors.text },
  callout: { fontSize: 31, fontWeight: '500', color: colors.text },
  subhead: { fontSize: 29, fontWeight: '400', color: colors.secondary },
  caption: { fontSize: 25, fontWeight: '500', color: colors.secondary },
  footnote: { fontSize: 23, fontWeight: '500', color: colors.tertiary },
});

/** The shadow under a lifted control. */
export const liftShadow = {
  shadowColor: colors.shadow,
  shadowOpacity: 0.45,
  shadowRadius: 24,
  shadowOffset: { width: 0, height: 16 },
} as const;
