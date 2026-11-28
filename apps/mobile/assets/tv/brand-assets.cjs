// The Apple TV icon and Top Shelf images for `@react-native-tvos/config-tv`, drawn by `render.mjs`.
const asset = filename => `./assets/tv/${filename}`;

/** tvOS tilts a focused icon's layers apart: the worm's eyes in front, its body, the violet behind. */
const layers = (name, scale = '') => ({
  front: asset(`${name}-front${scale}.png`),
  middle: asset(`${name}-middle${scale}.png`),
  back: asset(`${name}-back${scale}.png`),
});

module.exports = {
  // The App Store icon, 1280 × 768.
  iconLayers: layers('app-store'),
  // The Home Screen icon, 400 × 240 and 800 × 480.
  iconSmallLayers: layers('icon'),
  iconSmall2xLayers: layers('icon', '@2x'),
  // Top Shelf, 1920 × 720 and the wide 2320 × 720, at @1x and @2x.
  topShelf: asset('top-shelf.jpg'),
  topShelf2x: asset('top-shelf@2x.jpg'),
  topShelfWide: asset('top-shelf-wide.jpg'),
  topShelfWide2x: asset('top-shelf-wide@2x.jpg'),
};
