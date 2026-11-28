/**
 * The native engine's crossfade as Settings shows it: how long the end of one song overlaps
 * the start of the next. Off, or 2 to 12 seconds. Songs that follow each other on an album
 * played in order never crossfade (the engine's `albumRun`), so gapless albums stay gapless.
 */

export const crossfadeOptions: readonly { value: number; label: string }[] = [
  { value: 0, label: 'Off' },
  ...[2, 3, 4, 5, 6, 8, 10, 12].map(seconds => ({ value: seconds, label: `${seconds} Seconds` })),
];

export const crossfadeNote = 'Crossfade blends the end of each song into the start of the next. Songs that follow each other on an album you play in order still play without a gap, as the album was made.';

/** What was stored, in seconds, or Off for anything this app does not offer. */
export function readCrossfade(stored: unknown): number {
  return typeof stored === 'number' && crossfadeOptions.some(option => option.value === stored) ? stored : 0;
}
