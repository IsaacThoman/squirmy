/**
 * How far React Native text may grow with the system text size. Display text (page titles,
 * Now Playing's title) stops early: it is already large, and at accessibility sizes it would
 * push into the layout around it. Secondary lines grow further. Body text is not capped.
 */
export const displayFontScale = 1.3;
export const secondaryFontScale = 1.6;
