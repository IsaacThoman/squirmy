import { isApple } from '@/lib/platform'

const mod = isApple ? '⌘' : 'Ctrl'
const shift = isApple ? '⇧' : 'Shift'

/** One shortcut: the keys pressed together (or either of two), and what they do. */
export type Shortcut = { keys: string[][]; label: string }

/**
 * Every shortcut of the app, as the sheet lists them and `docs/use/web.md` documents them. Each
 * is left to a field being typed in, a menu, a slider and a dialog that uses the key (`keyIsTaken`,
 * `letterIsTaken`).
 */
export const SHORTCUT_GROUPS: { title: string; shortcuts: Shortcut[] }[] = [
  {
    title: 'Playback',
    shortcuts: [
      { keys: [['Space']], label: 'Play or pause' },
      { keys: [['←'], ['→']], label: 'Back or forward 5 seconds' },
      { keys: [[shift, '←'], [shift, '→']], label: 'Previous or next song' },
      { keys: [['↑'], ['↓']], label: 'Volume up or down' },
      { keys: [['M']], label: 'Mute or unmute' },
      { keys: [['S']], label: 'Shuffle' },
      { keys: [['R']], label: 'Repeat' },
      { keys: [['L']], label: 'Save the song playing to your library' },
    ],
  },
  {
    title: 'Views',
    shortcuts: [
      { keys: [[mod, 'K']], label: 'Search and commands' },
      { keys: [['/'], [mod, 'F']], label: 'Search' },
      { keys: [['Q']], label: 'Show or hide the queue' },
      { keys: [['Y']], label: 'Show or hide lyrics' },
      { keys: [[mod, 'B']], label: 'Fold the sidebar' },
      { keys: [[mod, ',']], label: 'Settings' },
      { keys: [['?']], label: 'Keyboard shortcuts' },
    ],
  },
  {
    title: 'Song lists',
    shortcuts: [
      { keys: [['Click']], label: 'Select a song' },
      { keys: [[mod, 'Click']], label: 'Add or remove a song' },
      { keys: [[shift, 'Click'], [shift, '↑'], [shift, '↓']], label: 'Select a range' },
      { keys: [[mod, 'A']], label: 'Select all' },
      { keys: [['Esc']], label: 'Clear the selection' },
      { keys: [['Double-click']], label: 'Play a song' },
    ],
  },
]
