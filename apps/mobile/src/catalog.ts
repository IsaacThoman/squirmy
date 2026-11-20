export type Track = {
  id: string
  title: string
  artist: string
  albumId: string
  duration: number
  lyrics?: string[]
}

export type Album = {
  id: string
  title: string
  artist: string
  artwork: number
  color: string
  genre: string
  year: number
  description: string
  trackIds: string[]
  kind: 'Album' | 'Playlist'
}

type TrackFixture = [id: string, title: string, duration: number, lyrics?: string[]]
type AlbumFixture = Omit<Album, 'trackIds' | 'kind'> & { songs: TrackFixture[] }

const records: AlbumFixture[] = [
  {
    id: 'blue-hour',
    title: 'Blue Hour',
    artist: 'Mira Vale',
    artwork: require('../assets/covers/01.jpg'),
    color: '#344763',
    genre: 'Dream Pop',
    year: 2025,
    description: 'Soft-focus synths and close-mic vocals trace the last light of the day. Mira Vale lets each song linger a little longer than it should.',
    songs: [
      ['night-swimming', 'Night Swimming', 224, [
        'The day goes quiet',
        'Blue on the water',
        'No one around us',
        'Just a little farther',
        'Hold your breath and count to ten',
        'Come up looking for the morning',
        'Every light along the shore',
        'Turns into a place we’ve been',
        'I could stay here all night',
        'Until the blue hour ends',
      ]],
      ['soft-signal', 'Soft Signal', 198],
      ['blue-in-the-dark', 'Blue in the Dark', 237],
      ['underwater-light', 'Underwater Light', 213],
      ['stay-until-morning', 'Stay Until Morning', 269],
    ],
  },
  {
    id: 'slow-motion',
    title: 'Slow Motion',
    artist: 'Lune Park',
    artwork: require('../assets/covers/02.jpg'),
    color: '#5a342a',
    genre: 'Alternative',
    year: 2024,
    description: 'A warm record for long drives and open windows. Drum machines give way to tape hiss, loose guitar, and slow-burning melodies.',
    songs: [
      ['amber', 'Amber', 206],
      ['after-the-rain', 'After the Rain', 218],
      ['riverside', 'Riverside', 241],
      ['open-window', 'Open Window', 198],
    ],
  },
  {
    id: 'glass-city',
    title: 'Glass City',
    artist: 'North Index',
    artwork: require('../assets/covers/03.jpg'),
    color: '#4a4d71',
    genre: 'Electronic',
    year: 2026,
    description: 'Wide, restless synths, tiny drum sounds, and the feeling of catching the last train through a city you barely know.',
    songs: [
      ['static-bloom', 'Static Bloom', 208],
      ['fifth-platform', 'Fifth Platform', 241],
      ['passing-glass', 'Passing Glass', 214],
      ['night-transit', 'Night Transit', 278],
    ],
  },
  {
    id: 'a-place-to-land',
    title: 'A Place to Land',
    artist: 'June Aster',
    artwork: require('../assets/covers/04.jpg'),
    color: '#5f404b',
    genre: 'Indie Pop',
    year: 2025,
    description: 'Small details fill the space between June Aster’s voice and a single piano. Acoustic songs tucked under a hazy bed of synths.',
    songs: [
      ['strange-seasons', 'Strange Seasons', 222],
      ['in-your-own-time', 'In Your Own Time', 189],
      ['half-awake', 'Half Awake', 201],
    ],
  },
  {
    id: 'air-between',
    title: 'Air Between',
    artist: 'Sora Fields',
    artwork: require('../assets/covers/05.jpg'),
    color: '#334e48',
    genre: 'Ambient',
    year: 2026,
    description: 'Field recordings and gentle keys drift in and out of these long, spacious pieces.',
    songs: [
      ['air-between', 'Air Between', 286],
      ['fern-line', 'Fern Line', 339],
      ['still-here', 'Still Here', 255],
    ],
  },
  {
    id: 'long-way-home',
    title: 'Long Way Home',
    artist: 'Ember Coast',
    artwork: require('../assets/covers/06.jpg'),
    color: '#64342e',
    genre: 'Indie Rock',
    year: 2024,
    description: 'The easy momentum of a late drive, with dust in the guitars and a drum groove that seems to run for miles.',
    songs: [
      ['tail-lights', 'Tail Lights', 218],
      ['mile-marker', 'Mile Marker', 235],
      ['red-sky-town', 'Red Sky Town', 202],
    ],
  },
  {
    id: 'every-shape',
    title: 'Every Shape',
    artist: 'Isla Noon',
    artwork: require('../assets/covers/07.jpg'),
    color: '#644936',
    genre: 'Neo-Soul',
    year: 2025,
    description: 'Brushed drums, brightly voiced chords, and a singer willing to leave a thought unfinished.',
    songs: [
      ['copper-lines', 'Copper Lines', 199],
      ['drawn-in', 'Drawn In', 231],
      ['little-world', 'Little World', 222],
    ],
  },
  {
    id: 'violet-noise',
    title: 'Violet Noise',
    artist: 'Coda West',
    artwork: require('../assets/covers/08.jpg'),
    color: '#543553',
    genre: 'Electronic',
    year: 2026,
    description: 'Four nocturnal cuts shaped by filtered house drums, distant voices, and pulses of distortion.',
    songs: [
      ['violet-noise', 'Violet Noise', 247],
      ['flashing-hours', 'Flashing Hours', 227],
      ['out-of-phase', 'Out of Phase', 259],
      ['lights-still-on', 'Lights Still On', 205],
    ],
  },
  {
    id: 'endless-room',
    title: 'Endless Room',
    artist: 'Harbor Theory',
    artwork: require('../assets/covers/09.jpg'),
    color: '#3f4854',
    genre: 'Ambient',
    year: 2025,
    description: 'Ceiling-high reverb and resonant strings give ordinary sounds the scale of a cathedral.',
    songs: [
      ['endless-room', 'Endless Room', 310],
      ['white-staircase', 'White Staircase', 284],
      ['quiet-architecture', 'Quiet Architecture', 321],
    ],
  },
  {
    id: 'bloom-tape',
    title: 'Bloom Tape',
    artist: 'Still Violet',
    artwork: require('../assets/covers/10.jpg'),
    color: '#60464f',
    genre: 'Dream Pop',
    year: 2026,
    description: 'Swirling home recordings that open up into big, unguarded choruses.',
    songs: [
      ['paper-flowers', 'Paper Flowers', 197],
      ['thread-count', 'Thread Count', 210],
      ['pale-green', 'Pale Green', 238],
    ],
  },
]

export const tracks = Object.fromEntries(
  records.flatMap(({ id: albumId, artist, songs }) =>
    songs.map(([id, title, duration, lyrics]) => [
      id, { id, title, artist, albumId, duration, lyrics },
    ] satisfies [string, Track]),
  ),
) as Record<string, Track>

const mixes: Album[] = [
  {
    id: 'after-dark',
    title: 'After Dark',
    artist: 'Squirmy',
    artwork: require('../assets/covers/11.jpg'),
    color: '#4d324b',
    genre: 'Electronic',
    year: 2026,
    description: 'Low-lit electronic, dream pop, and slow-burning tracks for the hours when the rest of the world goes quiet.',
    kind: 'Playlist',
    trackIds: [
      'night-swimming', 'static-bloom', 'amber', 'violet-noise',
      'endless-room', 'tail-lights', 'blue-in-the-dark', 'after-the-rain',
    ],
  },
  {
    id: 'first-light',
    title: 'First Light',
    artist: 'Squirmy',
    artwork: require('../assets/covers/12.jpg'),
    color: '#54523d',
    genre: 'Indie & Ambient',
    year: 2026,
    description: 'An unhurried start with soft keys, open spaces, and songs that let the morning in.',
    kind: 'Playlist',
    trackIds: [
      'strange-seasons', 'air-between', 'paper-flowers', 'drawn-in',
      'fern-line', 'little-world', 'stay-until-morning',
    ],
  },
]

export const albums = Object.fromEntries([
  ...records.map(({ songs, ...record }) => {
    return { ...record, kind: 'Album' as const, trackIds: songs.map(([id]) => id) }
  }),
  ...mixes,
].map(album => [album.id, album])) as Record<string, Album>

export const featuredAlbumIds = ['after-dark', 'first-light', 'blue-hour', 'glass-city']
export const libraryAlbumIds = [
  'after-dark', 'blue-hour', 'slow-motion', 'glass-city', 'a-place-to-land',
  'first-light', 'air-between', 'long-way-home', 'every-shape', 'violet-noise',
  'endless-room', 'bloom-tape',
]
export const autoplayTrackIds = [
  'amber', 'static-bloom', 'strange-seasons', 'violet-noise', 'paper-flowers',
  'endless-room', 'copper-lines', 'riverside', 'air-between', 'tail-lights',
]

export type Device = {
  id: string
  name: string
  subtitle: string
  icon: 'iphone' | 'laptopcomputer' | 'hifispeaker.fill' | 'headphones'
}

export const devices: Device[] = [
  { id: 'iphone', name: 'This iPhone', subtitle: 'This device', icon: 'iphone' },
  { id: 'living-room', name: 'Living Room', subtitle: 'Home speaker', icon: 'hifispeaker.fill' },
  { id: 'macbook', name: 'MacBook Pro', subtitle: 'On your network', icon: 'laptopcomputer' },
  { id: 'headphones', name: 'Studio Headphones', subtitle: 'Bluetooth', icon: 'headphones' },
]

export function formatTime(seconds: number): string {
  const whole = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`
}
