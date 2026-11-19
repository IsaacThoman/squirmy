import { Platform, useColorScheme } from 'react-native';

const palettes = {
  dark: {
    background: Platform.OS === 'ios' ? '#000000' : '#111014',
    surface: '#24212B',
    sheet: '#201C29',
    text: '#F5F2FF',
    muted: '#A9A2B4',
    quiet: '#938B9F',
    accent: '#CBC1FF',
    onAccent: '#19142B',
    stroke: '#FFFFFF22',
    overlay: '#FFFFFF0D',
    selection: '#CBC1FF1F',
    grabber: '#FFFFFF66',
    draggedRow: '#332A49',
    floating: '#282333D9',
    albumTint: 0.38,
    playerGradient: ['#11101B8A', '#181322AF', '#100E18', '#0E0C15'],
  },
  light: {
    background: '#FFFFFF',
    surface: '#F0EDF5',
    sheet: '#F8F6FB',
    text: '#211B2D',
    muted: '#625A70',
    quiet: '#6C627A',
    accent: '#5B439E',
    onAccent: '#FFFFFF',
    stroke: '#30213B26',
    overlay: '#30213B0D',
    selection: '#5B439E17',
    grabber: '#30213B75',
    draggedRow: '#E9E0F6',
    floating: '#F8F6FBE6',
    albumTint: 0.13,
    playerGradient: ['#FFF9FFB8', '#FAF5FBE0', '#F8F4FC', '#F7F3FB'],
  },
} as const;

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

/** The one translucent material every blurred surface uses, matching the album status bar's SwiftUI `ultraThin`. */
export const material = { tint: 'systemUltraThinMaterial', intensity: 100 } as const;

/** Alpha stops, top to bottom, for blurs that fade out beneath the status bar. */
export const statusFade = ['FF', 'F0', '80', '00'] as const;
