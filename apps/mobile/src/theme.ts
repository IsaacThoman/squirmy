import { Platform, useColorScheme } from 'react-native';
import { fadedArtOpacity, fadedText } from './faded';

const palettes = {
  dark: {
    background: Platform.OS === 'ios' ? '#000000' : '#111014',
    surface: '#242326',
    sheet: '#1C1B1E',
    text: '#F6F3F6',
    muted: '#ADA7AF',
    quiet: '#99939D',
    accent: '#CBC1FF',
    danger: '#FF8F87',
    onAccent: '#19142B',
    stroke: '#FFFFFF22',
    // The unfilled part of a slider: at least 3:1 against Now Playing's backdrop and the sheets, so the control shows before any of it is filled.
    sliderTrack: '#7C7780',
    overlay: '#FFFFFF0D',
    // An off toggle on a translucent backdrop, such as the queue's Shuffle, Repeat and Autoplay.
    chip: '#FFFFFF24',
    selection: '#CBC1FF1F',
    grabber: '#FFFFFF66',
    draggedRow: '#39363E',
    floating: '#29282CD9',
    albumTint: 0.24,
    fadedTitle: fadedText.dark.title,
    fadedCredit: fadedText.dark.credit,
    // Swipe actions on song and queue rows: Play next and Add to queue. White glyphs sit on them in both appearances.
    swipeNext: '#8071D4',
    swipeQueue: '#3D826D',
  },
  light: {
    background: '#FFFFFF',
    surface: '#F1EFF2',
    sheet: '#FAF9FA',
    text: '#211F22',
    muted: '#625E66',
    quiet: '#6C6570',
    accent: '#5B439E',
    danger: '#C42B2B',
    onAccent: '#FFFFFF',
    stroke: '#211F2226',
    sliderTrack: '#827C86',
    overlay: '#211F220D',
    chip: '#211F2217',
    selection: '#5B439E17',
    grabber: '#211F2275',
    draggedRow: '#E9E5EA',
    floating: '#FAF9FAE6',
    albumTint: 0.10,
    fadedTitle: fadedText.light.title,
    fadedCredit: fadedText.light.credit,
    swipeNext: '#8071D4',
    swipeQueue: '#3D826D',
  },
} as const;

/**
 * How far a gray (unavailable) tile, or a gray song's artwork, fades, the same everywhere.
 * A gray song's text takes `fadedTitle` and `fadedCredit` instead, which stay readable.
 */
export const unavailableOpacity = fadedArtOpacity;

export function useAppearance() {
  return useColorScheme() === 'dark' ? 'dark' : 'light';
}

export function useColors() {
  return palettes[useAppearance()];
}

export function createThemedStyles<T>(create: (colors: ReturnType<typeof useColors>) => T) {
  const styles = { light: create(palettes.light), dark: create(palettes.dark) };
  return function useStyles() {
    return styles[useAppearance()];
  };
}
