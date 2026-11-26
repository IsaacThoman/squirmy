const asset = filename => `./assets/tv/${filename}`;

const layers = width => ({
  front: asset(`eyes-${width}.png`),
  middle: asset(`body-${width}.png`),
  back: asset(`background-${width}.png`),
});

module.exports = {
  iconLayers: layers(1280),
  iconSmallLayers: layers(400),
  iconSmall2xLayers: layers(800),
  topShelf: asset('shelf-1920.jpg'),
  topShelf2x: asset('shelf-3840.jpg'),
  topShelfWide: asset('shelf-2320.jpg'),
  topShelfWide2x: asset('shelf-4640.jpg'),
};
