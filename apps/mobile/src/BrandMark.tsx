import { Image } from 'expo-image';

// Metro bundles an asset that is required; TypeScript has no type for a PNG import.
const mark: number = require('../assets/squirmy-mark.png');

/**
 * The googly worm mascot, as on the splash screen and the web app. It is a rounded tile like the
 * app icon, with its own violet, so it sits on the light and dark backgrounds alike.
 */
export function BrandMark({ size }: { size: number }) {
  return <Image source={mark} style={{ width: size, height: size }} contentFit="contain" accessible={false} />;
}
