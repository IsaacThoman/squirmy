// Draws the Apple TV app icon layers and Top Shelf images from the mascot in `../Squirmy.icon`.
// Run from the repository root after `npm install` (sharp comes with the server workspace):
//
//   node apps/mobile/assets/tv/render.mjs
//
// then run the TV prebuild again to copy them into the Xcode project. `brand-assets.cjs` names
// the files for `@react-native-tvos/config-tv`.
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const here = path.dirname(fileURLToPath(import.meta.url));
const mascot = path.join(here, '..', 'Squirmy.icon', 'Assets');
const out = process.argv[2] ?? here;

// The iOS icon's violet, the TV app's accents and its charcoal.
const violet = '#9D99D6';
const lilac = '#CBC1FF';
const deep = '#5B52B8';
const ink = '#14121C';

/** The mascot's source layers are 1024 pt squares; its head sits at (520, 520), 200 pt across. */
const source = 1024;
const head = { x: 520, y: 520 };

/**
 * The body runs off the left and bottom of its square. tvOS slides an icon's layers apart as it
 * tilts, so the cut ends would show: the edge pixels are copied outward to carry the body on.
 */
const bleed = 240;
async function bodySource() {
  return sharp(path.join(mascot, 'worm-body.png'))
    .extend({ left: bleed, bottom: bleed, extendWith: 'copy' })
    .png().toBuffer();
}

/**
 * Places `image` (its top left at `x`, `y`, scaled by `scale`, optionally mirrored) on a clear
 * `width` × `height` canvas, cropping what falls outside: sharp composites only what fits.
 */
async function place(image, { scale, x, y, width, height, flop = false }) {
  const meta = await sharp(image).metadata();
  const w = Math.round(meta.width * scale);
  const h = Math.round(meta.height * scale);
  let resized = sharp(image).resize(w, h, { kernel: 'lanczos3' });
  if (flop) resized = resized.flop();
  const left = Math.round(x);
  const top = Math.round(y);
  const crop = {
    left: Math.max(0, -left), top: Math.max(0, -top),
    width: Math.min(w, width - left) - Math.max(0, -left), height: Math.min(h, height - top) - Math.max(0, -top),
  };
  const canvas = sharp({ create: { width, height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } });
  if (crop.width <= 0 || crop.height <= 0) return canvas.png().toBuffer();
  const piece = await sharp(await resized.png().toBuffer()).extract(crop).png().toBuffer();
  return canvas.composite([{ input: piece, left: Math.max(0, left), top: Math.max(0, top) }]).png().toBuffer();
}

/** A soft shadow of `layer`'s shape in `color`, blurred by `blur` px and moved down by `drop`. */
async function shadowOf(layer, { color, opacity, blur, drop }) {
  const { data, info } = await sharp(layer).raw().toBuffer({ resolveWithObject: true });
  const [r, g, b] = [1, 3, 5].map(at => parseInt(color.slice(at, at + 2), 16));
  for (let at = 0; at < data.length; at += 4) {
    data[at] = r;
    data[at + 1] = g;
    data[at + 2] = b;
    data[at + 3] = Math.round(data[at + 3] * opacity);
  }
  const shape = await sharp(data, { raw: info }).png().toBuffer();
  return sharp({ create: { width: info.width, height: info.height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: await sharp(shape).blur(blur).png().toBuffer(), left: 0, top: Math.round(drop) }])
    .png().toBuffer();
}

/** Stacks layers, first at the back, on a clear canvas. */
async function stack(width, height, layers) {
  return sharp({ create: { width, height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite(layers.map(input => ({ input }))).png().toBuffer();
}

const svg = (width, height, body) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${body}</svg>`);

/** Rings of sound spreading from (cx, cy), fading as they go. */
function ripples(cx, cy, { first, step, count, width, from, to }) {
  return Array.from({ length: count }, (_, ring) => {
    const opacity = from + (to - from) * (ring / Math.max(1, count - 1));
    return `<circle cx="${cx}" cy="${cy}" r="${first + step * ring}" fill="none" stroke="#FFFFFF" stroke-width="${width}" stroke-opacity="${opacity.toFixed(3)}"/>`;
  }).join('');
}

/** A seeded generator, so the sparkles land in the same places on every run. */
function random(seed) {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

/**
 * The app icon at `width` (tvOS icons are 5:3): a violet back layer with rings of sound from the
 * worm's head, the worm's body in the middle, and its googly eyes in front, so focus tilts them
 * apart. Geometry is laid out on the 1280 pt App Store icon and scaled.
 */
async function icon(width) {
  const height = Math.round(width * 0.6);
  const k = width / 1280;
  const scale = 0.98 * k;
  const origin = { x: -60 * k, y: -150 * k };
  const centre = { x: origin.x + head.x * scale, y: origin.y + head.y * scale };

  const back = await sharp(svg(width, height, `
    <defs>
      <linearGradient id="wash" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="#B9B4EE"/><stop offset="0.55" stop-color="${violet}"/><stop offset="1" stop-color="${deep}"/>
      </linearGradient>
      <radialGradient id="glow" cx="${centre.x}" cy="${centre.y}" r="${620 * k}" gradientUnits="userSpaceOnUse">
        <stop offset="0" stop-color="#FFFFFF" stop-opacity="0.38"/><stop offset="1" stop-color="#FFFFFF" stop-opacity="0"/>
      </radialGradient>
      <radialGradient id="corner" cx="${width}" cy="${height}" r="${760 * k}" gradientUnits="userSpaceOnUse">
        <stop offset="0" stop-color="#3B2F8F" stop-opacity="0.55"/><stop offset="1" stop-color="#3B2F8F" stop-opacity="0"/>
      </radialGradient>
    </defs>
    <rect width="${width}" height="${height}" fill="url(#wash)"/>
    <rect width="${width}" height="${height}" fill="url(#glow)"/>
    <rect width="${width}" height="${height}" fill="url(#corner)"/>
    ${ripples(centre.x, centre.y, { first: 300 * k, step: 118 * k, count: 7, width: 9 * k, from: 0.34, to: 0.06 })}
  `)).flatten({ background: violet }).removeAlpha().png().toBuffer();

  const body = await place(await bodySource(), { scale, x: origin.x - bleed * scale, y: origin.y, width, height });
  const middle = await stack(width, height, [await shadowOf(body, { color: '#2E2479', opacity: 0.5, blur: 1 + 26 * k, drop: 22 * k }), body]);

  const eyes = await place(path.join(mascot, 'worm-face.png'), { scale, x: origin.x, y: origin.y, width, height });
  const front = await stack(width, height, [await shadowOf(eyes, { color: '#3A2C6E', opacity: 0.45, blur: 1 + 10 * k, drop: 10 * k }), eyes]);

  return { back, middle, front };
}

/**
 * A Top Shelf banner (720 pt tall) at `scale`: night violet, a field of soft sparkles and rings of
 * sound, and the worm, mirrored, rising from the bottom right to look across it.
 */
async function topShelf(widthPt, pixelScale) {
  const width = widthPt * pixelScale;
  const height = 720 * pixelScale;
  const p = pixelScale;
  const wormScale = 1.02 * p;
  // Mirrored, the body runs off the right and the bottom; its square's right edge sits past the banner's.
  const right = width + 16 * p;
  const top = height - 820 * p;
  const left = right - source * wormScale;
  const centre = { x: right - head.x * wormScale, y: top + head.y * wormScale };

  const next = random(20261126 + widthPt);
  const sparkles = Array.from({ length: Math.round(widthPt / 18) }, () => {
    const x = next() * (centre.x - 160 * p);
    const y = next() * height;
    const r = (1.5 + next() * next() * 7) * p;
    return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${r.toFixed(1)}" fill="${next() > 0.6 ? lilac : '#FFFFFF'}" fill-opacity="${(0.08 + next() * 0.32).toFixed(2)}"/>`;
  }).join('');

  const backdrop = svg(width, height, `
    <defs>
      <linearGradient id="night" x1="0" y1="0" x2="1" y2="0.4">
        <stop offset="0" stop-color="${ink}"/><stop offset="0.5" stop-color="#231C45"/><stop offset="1" stop-color="#4A3FA0"/>
      </linearGradient>
      <radialGradient id="glow" cx="${centre.x}" cy="${centre.y}" r="${760 * p}" gradientUnits="userSpaceOnUse">
        <stop offset="0" stop-color="${violet}" stop-opacity="0.75"/><stop offset="0.45" stop-color="${deep}" stop-opacity="0.35"/>
        <stop offset="1" stop-color="${deep}" stop-opacity="0"/>
      </radialGradient>
      <linearGradient id="floor" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0.6" stop-color="#000000" stop-opacity="0"/><stop offset="1" stop-color="#000000" stop-opacity="0.35"/>
      </linearGradient>
    </defs>
    <rect width="${width}" height="${height}" fill="url(#night)"/>
    <rect width="${width}" height="${height}" fill="url(#glow)"/>
    ${ripples(centre.x, centre.y, { first: 280 * p, step: 120 * p, count: 9, width: 4 * p, from: 0.3, to: 0.02 })}
    ${sparkles}
    <rect width="${width}" height="${height}" fill="url(#floor)"/>
  `);

  const body = await place(path.join(mascot, 'worm-body.png'), { scale: wormScale, x: left, y: top, width, height, flop: true });
  const eyes = await place(path.join(mascot, 'worm-face.png'), { scale: wormScale, x: left, y: top, width, height, flop: true });
  const image = await sharp(backdrop).composite([
    { input: await shadowOf(body, { color: '#0B0716', opacity: 0.6, blur: 30 * p, drop: 20 * p }) },
    { input: body },
    { input: await shadowOf(eyes, { color: '#1E1640', opacity: 0.4, blur: 8 * p, drop: 8 * p }) },
    { input: eyes },
  ]).png().toBuffer();
  return sharp(image).flatten({ background: ink }).removeAlpha().jpeg({ quality: 90, mozjpeg: true }).toBuffer();
}

await mkdir(out, { recursive: true });
const write = (name, buffer) => sharp(buffer).toFile(path.join(out, name));

for (const [name, width] of [['app-store', 1280], ['icon', 400], ['icon@2x', 800]]) {
  const layers = await icon(width);
  for (const layer of ['back', 'middle', 'front']) {
    const [base, suffix = ''] = name.split('@');
    await write(`${base}-${layer}${suffix ? `@${suffix}` : ''}.png`, layers[layer]);
  }
}
for (const [name, widthPt] of [['top-shelf', 1920], ['top-shelf-wide', 2320]]) {
  await write(`${name}.jpg`, await topShelf(widthPt, 1));
  await write(`${name}@2x.jpg`, await topShelf(widthPt, 2));
}
console.log(`Wrote the Apple TV icon and Top Shelf images to ${path.relative(process.cwd(), out) || '.'}.`);
