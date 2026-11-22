/**
 * A fictional catalog, ported from the iOS prototype, shaped like the API's responses.
 * Pages read from here until they are wired to the server.
 */
import type {
  AlbumDetail, AlbumSummary, AlbumType, ArtistDetail, ArtistSummary, Artwork, ArtSize, HomeResponse, Lyrics,
  PlaylistDetail, PlaylistSummary, TrackAvailability, TrackSummary,
} from '@squirmy/contracts'

/** Stable UUIDs, so fixture links survive reloads. `kind` keeps the id spaces apart. */
function uuid(kind: number, n: number) {
  return `00000000-0000-4000-8${kind}00-${n.toString(16).padStart(12, '0')}`
}

const thumbhashes = [
  'mGcKDwhZiHh/h4d2eWeId3h4mMBHKX8E', 'j5kGFwYMjHd2l3mmameJlneJ52BoD4YH', 'WtcJDwIAh3eWhmijh2eKWKeF9dmnnW8K',
  'WvwGHwL1q4d3eIdth3d3p3mHV3/XCZoC', 'T9cFFwYQWmqGaGhFidh2SMZolAdZeaAD', '0AgKFwRbd4efd3eIiIeHeHd3uPJrS78H',
  'j/kFHwK5bFVnhnhwR6iqh4dap2sGAJgJ', 'V5YFFwhIh3ideHhbiAeIeHeahWkFiV0A', 'XakKFwR6h4h/d4h2eGd4d3h4WAZ4ZJAH',
  'E2gGBwaYVnaQh5dCidh5WHmF9zhkiJAD', 'UTkGFwR3cnj6Y3Z5dniWJ5qph7efd/kJ', 'GnkKLwiFeHePd4h4iFiHZ4iIOAhpgaAG',
]
const coverColors = [
  '#344763', '#5a342a', '#4a4d71', '#5f404b', '#334e48', '#64342e', '#644936', '#543553', '#3f4854', '#60464f', '#4d324b', '#54523d',
]
const coverUrls = new Map<string, string>()

/** A plain square in the cover's colour, so the fixture ships no artwork. */
function coverSvg(color: string) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><rect width="1" height="1" fill="${color}"/></svg>`
  return `data:image/svg+xml,${encodeURIComponent(svg)}`
}

/** Cover `n` (1–12) as an Artwork. Artist images reuse a cover under their own asset id. */
function art(n: number, assetId = uuid(9, n)): Artwork {
  coverUrls.set(assetId, coverSvg(coverColors[n - 1]))
  return { id: assetId, color: coverColors[n - 1], thumbhash: thumbhashes[n - 1] }
}

/** Resolves fixture artwork to its generated cover. Unknown ids fall back to the real art route. */
export function fixtureArtUrl(artwork: Artwork, size: ArtSize) {
  return coverUrls.get(artwork.id) ?? `/api/v1/art/${artwork.id}/${size}`
}

type ArtistSeed = { slug: string; name: string; cover: number | null; inLibrary: boolean; genres: string[]; bio?: string }

const artistSeeds: ArtistSeed[] = [
  { slug: 'mira-vale', name: 'Mira Vale', cover: 1, inLibrary: true, genres: ['Dream Pop', 'Synth Pop'],
    bio: 'Mira Vale writes slow, glowing songs out of a converted boathouse on the edge of a lake. Her records are built from close-mic vocals, drifting synthesizers and whatever the weather is doing that week. Blue Hour, her second album, was recorded almost entirely after sunset.' },
  { slug: 'lune-park', name: 'Lune Park', cover: 2, inLibrary: true, genres: ['Alternative', 'Indie Rock'],
    bio: 'A three-piece that trades between drum machines and a borrowed tape deck. Lune Park started as a weekend project and kept going because nobody wanted to stop.' },
  { slug: 'north-index', name: 'North Index', cover: 3, inLibrary: true, genres: ['Electronic'] },
  { slug: 'june-aster', name: 'June Aster', cover: 4, inLibrary: true, genres: ['Indie Pop', 'Singer-Songwriter'] },
  { slug: 'sora-fields', name: 'Sora Fields', cover: 5, inLibrary: true, genres: ['Ambient'] },
  { slug: 'ember-coast', name: 'Ember Coast', cover: 6, inLibrary: true, genres: ['Indie Rock'] },
  { slug: 'isla-noon', name: 'Isla Noon', cover: 7, inLibrary: true, genres: ['Neo-Soul'] },
  { slug: 'coda-west', name: 'Coda West', cover: 8, inLibrary: true, genres: ['Electronic', 'House'] },
  { slug: 'harbor-theory', name: 'Harbor Theory', cover: 9, inLibrary: true, genres: ['Ambient', 'Modern Classical'] },
  { slug: 'still-violet', name: 'Still Violet', cover: 10, inLibrary: true, genres: ['Dream Pop'] },
  { slug: 'pale-meridian', name: 'Pale Meridian', cover: null, inLibrary: false, genres: ['Shoegaze'] },
]

export const artists: ArtistSummary[] = artistSeeds.map((seed, index) => ({
  id: uuid(1, index + 1),
  mbid: null,
  name: seed.name,
  image: seed.cover ? art(seed.cover, uuid(8, seed.cover)) : null,
  inLibrary: seed.inLibrary,
}))
const artistBySlug = new Map(artistSeeds.map((seed, index) => [seed.slug, artists[index]]))

type SongSeed = {
  slug: string
  title: string
  seconds: number
  availability?: TrackAvailability
  liked?: boolean
  explicit?: boolean
  lyrics?: boolean
  disc?: number
}

type AlbumSeed = {
  slug: string
  title: string
  artist: string
  cover: number | null
  year: number
  type: AlbumType
  genres: string[]
  label: string
  description?: string
  discTitles?: Record<number, string>
  songs: SongSeed[]
  liked?: boolean
  wanted?: boolean
  /** Defaults to every track's availability; catalog-only albums set it. */
  availability?: TrackAvailability
}

const albumSeeds: AlbumSeed[] = [
  {
    slug: 'blue-hour', title: 'Blue Hour', artist: 'mira-vale', cover: 1, year: 2025, type: 'album', genres: ['Dream Pop'],
    label: 'Lakeside Tapes', liked: true,
    description: 'Soft-focus synths and close-mic vocals trace the last light of the day. Mira Vale lets each song linger a little longer than it should.',
    discTitles: { 2: 'Bonus Tracks' },
    songs: [
      { slug: 'night-swimming', title: 'Night Swimming', seconds: 224, liked: true, lyrics: true },
      { slug: 'soft-signal', title: 'Soft Signal', seconds: 198 },
      { slug: 'blue-in-the-dark', title: 'Blue in the Dark', seconds: 237, liked: true },
      { slug: 'underwater-light', title: 'Underwater Light', seconds: 213 },
      { slug: 'stay-until-morning', title: 'Stay Until Morning', seconds: 269 },
      { slug: 'night-swimming-demo', title: 'Night Swimming (Demo)', seconds: 201, availability: 'on_demand', disc: 2 },
      { slug: 'soft-signal-live', title: 'Soft Signal (Live)', seconds: 245, availability: 'none', disc: 2 },
    ],
  },
  {
    slug: 'slow-motion', title: 'Slow Motion', artist: 'lune-park', cover: 2, year: 2024, type: 'album', genres: ['Alternative'],
    label: 'Open Window Records',
    description: 'A warm record for long drives and open windows. Drum machines give way to tape hiss, loose guitar, and slow-burning melodies.',
    songs: [
      { slug: 'amber', title: 'Amber', seconds: 206, liked: true },
      { slug: 'after-the-rain', title: 'After the Rain', seconds: 218, explicit: true },
      { slug: 'riverside', title: 'Riverside', seconds: 241 },
      { slug: 'open-window', title: 'Open Window', seconds: 198 },
    ],
  },
  {
    slug: 'glass-city', title: 'Glass City', artist: 'north-index', cover: 3, year: 2026, type: 'album', genres: ['Electronic'],
    label: 'Transit Audio',
    description: 'Wide, restless synths, tiny drum sounds, and the feeling of catching the last train through a city you barely know.',
    songs: [
      { slug: 'static-bloom', title: 'Static Bloom', seconds: 208 },
      { slug: 'fifth-platform', title: 'Fifth Platform', seconds: 241 },
      { slug: 'passing-glass', title: 'Passing Glass', seconds: 214, liked: true },
      { slug: 'night-transit', title: 'Night Transit', seconds: 278 },
    ],
  },
  {
    slug: 'a-place-to-land', title: 'A Place to Land', artist: 'june-aster', cover: 4, year: 2025, type: 'album', genres: ['Indie Pop'],
    label: 'Small Hours',
    description: 'Small details fill the space between June Aster’s voice and a single piano. Acoustic songs tucked under a hazy bed of synths.',
    songs: [
      { slug: 'strange-seasons', title: 'Strange Seasons', seconds: 222 },
      { slug: 'in-your-own-time', title: 'In Your Own Time', seconds: 189 },
      { slug: 'half-awake', title: 'Half Awake', seconds: 201 },
    ],
  },
  {
    slug: 'air-between', title: 'Air Between', artist: 'sora-fields', cover: 5, year: 2026, type: 'ep', genres: ['Ambient'],
    label: 'Fernline',
    description: 'Field recordings and gentle keys drift in and out of these long, spacious pieces.',
    songs: [
      { slug: 'air-between-song', title: 'Air Between', seconds: 286 },
      { slug: 'fern-line', title: 'Fern Line', seconds: 339 },
      { slug: 'still-here', title: 'Still Here', seconds: 255 },
    ],
  },
  {
    slug: 'long-way-home', title: 'Long Way Home', artist: 'ember-coast', cover: 6, year: 2024, type: 'album', genres: ['Indie Rock'],
    label: 'Red Sky',
    description: 'The easy momentum of a late drive, with dust in the guitars and a drum groove that seems to run for miles.',
    songs: [
      { slug: 'tail-lights', title: 'Tail Lights', seconds: 218, explicit: true },
      { slug: 'mile-marker', title: 'Mile Marker', seconds: 235 },
      { slug: 'red-sky-town', title: 'Red Sky Town', seconds: 202 },
    ],
  },
  {
    slug: 'every-shape', title: 'Every Shape', artist: 'isla-noon', cover: 7, year: 2025, type: 'album', genres: ['Neo-Soul'],
    label: 'Copperline',
    description: 'Brushed drums, brightly voiced chords, and a singer willing to leave a thought unfinished.',
    songs: [
      { slug: 'copper-lines', title: 'Copper Lines', seconds: 199 },
      { slug: 'drawn-in', title: 'Drawn In', seconds: 231, liked: true },
      { slug: 'little-world', title: 'Little World', seconds: 222 },
    ],
  },
  {
    slug: 'violet-noise', title: 'Violet Noise', artist: 'coda-west', cover: 8, year: 2026, type: 'ep', genres: ['Electronic'],
    label: 'Phase Records',
    description: 'Four nocturnal cuts shaped by filtered house drums, distant voices, and pulses of distortion.',
    songs: [
      { slug: 'violet-noise-song', title: 'Violet Noise', seconds: 247 },
      { slug: 'flashing-hours', title: 'Flashing Hours', seconds: 227 },
      { slug: 'out-of-phase', title: 'Out of Phase', seconds: 259 },
      { slug: 'lights-still-on', title: 'Lights Still On', seconds: 205 },
    ],
  },
  {
    slug: 'endless-room', title: 'Endless Room', artist: 'harbor-theory', cover: 9, year: 2025, type: 'album', genres: ['Ambient'],
    label: 'Quiet Architecture',
    description: 'Ceiling-high reverb and resonant strings give ordinary sounds the scale of a cathedral.',
    songs: [
      { slug: 'endless-room-song', title: 'Endless Room', seconds: 310 },
      { slug: 'white-staircase', title: 'White Staircase', seconds: 284 },
      { slug: 'quiet-architecture', title: 'Quiet Architecture', seconds: 321 },
    ],
  },
  {
    slug: 'bloom-tape', title: 'Bloom Tape', artist: 'still-violet', cover: 10, year: 2026, type: 'album', genres: ['Dream Pop'],
    label: 'Paper Flower',
    description: 'Swirling home recordings that open up into big, unguarded choruses.',
    songs: [
      { slug: 'paper-flowers', title: 'Paper Flowers', seconds: 197 },
      { slug: 'thread-count', title: 'Thread Count', seconds: 210 },
      { slug: 'pale-green', title: 'Pale Green', seconds: 238 },
    ],
  },
  // Catalog-only releases: browsed or searched, not owned.
  {
    slug: 'low-tide', title: 'Low Tide', artist: 'mira-vale', cover: 11, year: 2026, type: 'single', genres: ['Dream Pop'],
    label: 'Lakeside Tapes', availability: 'on_demand', wanted: true,
    songs: [{ slug: 'low-tide-song', title: 'Low Tide', seconds: 231 }, { slug: 'low-tide-edit', title: 'Low Tide (Radio Edit)', seconds: 199 }],
  },
  {
    slug: 'live-glasshouse', title: 'Live at the Glasshouse', artist: 'mira-vale', cover: 12, year: 2024, type: 'live', genres: ['Dream Pop'],
    label: 'Lakeside Tapes', availability: 'none',
    songs: [
      { slug: 'glasshouse-night-swimming', title: 'Night Swimming (Live)', seconds: 262 },
      { slug: 'glasshouse-blue', title: 'Blue in the Dark (Live)', seconds: 251 },
      { slug: 'glasshouse-stay', title: 'Stay Until Morning (Live)', seconds: 301 },
    ],
  },
  {
    slug: 'paper-moons', title: 'Paper Moons', artist: 'mira-vale', cover: null, year: 2022, type: 'ep', genres: ['Dream Pop'],
    label: 'Self-released', availability: 'none',
    songs: [{ slug: 'paper-moons-song', title: 'Paper Moons', seconds: 214 }, { slug: 'quiet-water', title: 'Quiet Water', seconds: 236 }],
  },
  {
    slug: 'northbound', title: 'Northbound', artist: 'lune-park', cover: null, year: 2026, type: 'single', genres: ['Alternative'],
    label: 'Open Window Records', availability: 'none',
    songs: [{ slug: 'northbound-song', title: 'Northbound', seconds: 204 }],
  },
  {
    slug: 'afterimage', title: 'Afterimage', artist: 'coda-west', cover: 12, year: 2026, type: 'ep', genres: ['Electronic'],
    label: 'Phase Records', availability: 'on_demand',
    songs: [{ slug: 'afterimage-song', title: 'Afterimage', seconds: 243 }, { slug: 'strobe-hymn', title: 'Strobe Hymn', seconds: 266 }],
  },
  {
    slug: 'soft-static', title: 'Soft Static', artist: 'pale-meridian', cover: null, year: 2025, type: 'album', genres: ['Shoegaze'],
    label: 'Meridian', availability: 'none',
    songs: [{ slug: 'soft-static-song', title: 'Soft Static', seconds: 288 }, { slug: 'glass-garden', title: 'Glass Garden', seconds: 241 }],
  },
]

const tracksBySlug = new Map<string, TrackSummary>()
export const albums: AlbumDetail[] = albumSeeds.map((seed, albumIndex) => {
  const artist = artistBySlug.get(seed.artist)!
  const artwork = seed.cover ? art(seed.cover) : null
  const albumId = uuid(2, albumIndex + 1)
  const ref = { id: albumId, title: seed.title, artwork }
  const discNumbers = [...new Set(seed.songs.map(song => song.disc ?? 1))]
  const tracks = seed.songs.map(song => {
    const disc = song.disc ?? 1
    const track: TrackSummary = {
      id: uuid(3, tracksBySlug.size + 1),
      mbid: null,
      title: song.title,
      artistCredit: artist.name,
      artists: [{ id: artist.id, name: artist.name }],
      durationMs: song.seconds * 1000,
      album: ref,
      disc,
      position: seed.songs.filter(other => (other.disc ?? 1) === disc).indexOf(song) + 1,
      availability: song.availability ?? seed.availability ?? 'server',
      liked: Boolean(song.liked),
      explicit: song.explicit ?? false,
      hasLyrics: Boolean(song.lyrics),
      // What is on the server here was brought by its owner: in everyone's library.
      inLibrary: (song.availability ?? seed.availability ?? 'server') === 'server',
    }
    tracksBySlug.set(song.slug, track)
    return track
  })
  const owned = tracks.filter(track => track.availability === 'server').length
  return {
    id: albumId,
    mbid: null,
    title: seed.title,
    artistCredit: artist.name,
    artists: [{ id: artist.id, name: artist.name }],
    year: seed.year,
    type: seed.type,
    artwork,
    availability: owned === tracks.length ? 'full' : owned ? 'partial' : seed.availability === 'on_demand' ? 'on_demand' : 'none',
    trackCount: tracks.length,
    ownedTrackCount: owned,
    releaseDate: `${seed.year}-0${(albumIndex % 9) + 1}-14`,
    genres: seed.genres,
    description: seed.description ?? null,
    label: seed.label,
    durationMs: tracks.reduce((sum, track) => sum + track.durationMs, 0),
    discs: discNumbers.map(disc => ({ disc, title: seed.discTitles?.[disc] ?? null, tracks: tracks.filter(track => track.disc === disc) })),
    liked: Boolean(seed.liked),
    wanted: Boolean(seed.wanted),
    library: owned ? 'collection' : null,
  }
})

export function summary({ id, mbid, title, artistCredit, artists, year, type, artwork, availability, trackCount, ownedTrackCount }: AlbumDetail): AlbumSummary {
  return { id, mbid, title, artistCredit, artists, year, type, artwork, availability, trackCount, ownedTrackCount }
}

const albumBySlug = new Map(albumSeeds.map((seed, index) => [seed.slug, albums[index]]))
export const track = (slug: string) => tracksBySlug.get(slug)!
export const album = (slug: string) => albumBySlug.get(slug)!
export const allTracks = [...tracksBySlug.values()]

export const libraryAlbums = albums.filter(item => item.availability === 'full' || item.availability === 'partial').map(summary)
export const libraryArtists = artists.filter(artist => artist.inLibrary)
export const libraryTracks = allTracks.filter(item => item.availability === 'server')
export const likedTracks = allTracks.filter(item => item.liked)

export function albumDetail(id: string) {
  return albums.find(item => item.id === id) ?? null
}

export function artistDetail(id: string): ArtistDetail | null {
  const index = artists.findIndex(artist => artist.id === id)
  if (index < 0) return null
  const seed = artistSeeds[index]
  const own = albums.filter(item => item.artists.some(credit => credit.id === id))
  return {
    ...artists[index],
    sortName: null,
    disambiguation: null,
    bio: seed.bio ?? null,
    bioUrl: seed.bio ? 'https://en.wikipedia.org/wiki/Special:Random' : null,
    genres: seed.genres,
    liked: index === 0,
    topTracks: own.flatMap(item => item.discs.flatMap(disc => disc.tracks)).slice(0, 5),
    albums: own.map(summary).sort((a, b) => (b.year ?? 0) - (a.year ?? 0)),
    similar: artists.filter(artist => artist.id !== id && artist.inLibrary).slice(index % 4, (index % 4) + 6),
  }
}

const updatedAt = '2026-11-18T21:40:00.000Z'
const owner = { ownerId: uuid(6, 1), ownerName: 'alex' }

function playlist(n: number, name: string, description: string | null, slugs: string[]): PlaylistDetail {
  const items = slugs.map((slug, index) => ({
    itemId: uuid(5, n * 100 + index),
    addedAt: new Date(Date.parse(updatedAt) - index * 86400000 * 3).toISOString(),
    track: track(slug),
  }))
  const artworks = [...new Map(items.flatMap(item => item.track.album?.artwork ? [[item.track.album.artwork.id, item.track.album.artwork]] : [])).values()].slice(0, 4)
  return {
    id: uuid(4, n), name, description, ...owner, isPublic: n === 1, trackCount: items.length,
    durationMs: items.reduce((sum, item) => sum + item.track.durationMs, 0), artworks, updatedAt, items,
  }
}

export const playlists: PlaylistDetail[] = [
  playlist(1, 'After Dark', 'Low-lit electronic, dream pop, and slow-burning tracks for the hours when the rest of the world goes quiet.', [
    'night-swimming', 'static-bloom', 'amber', 'violet-noise-song', 'endless-room-song', 'tail-lights', 'blue-in-the-dark', 'after-the-rain',
  ]),
  playlist(2, 'First Light', 'An unhurried start with soft keys, open spaces, and songs that let the morning in.', [
    'strange-seasons', 'air-between-song', 'paper-flowers', 'drawn-in', 'fern-line', 'little-world', 'stay-until-morning',
  ]),
  playlist(3, 'Late Train', null, ['fifth-platform', 'night-transit', 'mile-marker', 'low-tide-song']),
  playlist(4, 'Empty for now', 'Nothing here yet.', []),
]

export const playlistSummaries: PlaylistSummary[] = playlists.map(({ items: _items, ...rest }) => rest)

export function playlistDetail(id: string) {
  return playlists.find(item => item.id === id) ?? null
}

export const home: HomeResponse = {
  sections: [
    { kind: 'albums', id: 'recently-played', title: 'Recently played',
      albums: ['blue-hour', 'glass-city', 'slow-motion', 'every-shape', 'violet-noise', 'a-place-to-land'].map(slug => summary(album(slug))) },
    { kind: 'playlists', id: 'playlists', title: 'Your playlists', playlists: playlistSummaries.slice(0, 3) },
    { kind: 'albums', id: 'recently-added', title: 'Recently added',
      albums: ['bloom-tape', 'endless-room', 'air-between', 'long-way-home', 'every-shape', 'glass-city', 'a-place-to-land'].map(slug => summary(album(slug))) },
    { kind: 'artists', id: 'artists', title: 'Artists you play', artists: libraryArtists.slice(0, 8) },
    { kind: 'albums', id: 'new-releases', title: 'New from artists you own',
      albums: ['low-tide', 'afterimage', 'northbound'].map(slug => summary(album(slug))) },
    { kind: 'tracks', id: 'on-repeat', title: 'On repeat',
      tracks: ['night-swimming', 'amber', 'passing-glass', 'drawn-in', 'static-bloom', 'blue-in-the-dark'].map(track) },
  ],
}

export const genres = [...new Map(libraryAlbums.flatMap(item => albumDetail(item.id)!.genres.map(genre => [genre, item] as const))).entries()]
  .map(([name, item]) => ({ name, artwork: item.artwork }))

/** Library hits come first, then catalog results the library does not already cover. */
export function searchFixtures(query: string) {
  const terms = normalize(query).split(/\s+/).filter(Boolean)
  const matches = (...values: string[]) => terms.every(term => normalize(values.join(' ')).includes(term))
  const library = {
    artists: libraryArtists.filter(artist => matches(artist.name)),
    albums: libraryAlbums.filter(item => matches(item.title, item.artistCredit)),
    tracks: libraryTracks.filter(item => matches(item.title, item.artistCredit, item.album?.title ?? '')),
    provider: null,
  }
  // The server's `top`, simplified: an artist, album or song named exactly as asked.
  const exact = (name: string) => normalize(name) === normalize(query.trim())
  const topArtist = library.artists.find(artist => exact(artist.name))
  const topAlbum = library.albums.find(item => exact(item.title))
  const topTrack = library.tracks.find(item => exact(item.title))
  const top = topArtist ? { type: 'artist' as const, id: topArtist.id } : topAlbum ? { type: 'album' as const, id: topAlbum.id } : topTrack ? { type: 'track' as const, id: topTrack.id } : null
  const catalog = {
    artists: artists.filter(artist => !artist.inLibrary && matches(artist.name)),
    albums: albums.filter(item => item.availability === 'none' || item.availability === 'on_demand').map(summary).filter(item => matches(item.title, item.artistCredit)),
    tracks: allTracks.filter(item => item.availability !== 'server' && matches(item.title, item.artistCredit)),
    provider: 'deezer',
  }
  return { library: { ...library, top }, catalog }
}

function normalize(value: string) {
  return value.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
}

export const wantlist = {
  albums: albums.filter(item => item.wanted).map(summary).concat(summary(album('live-glasshouse'))),
  tracks: [track('soft-signal-live'), track('afterimage-song'), track('glass-garden')],
}

const nightSwimming = [
  'The day goes quiet', 'Blue on the water', 'No one around us', 'Just a little farther', 'Hold your breath and count to ten',
  'Come up looking for the morning', 'Every light along the shore', 'Turns into a place we’ve been', 'I could stay here all night',
  'Until the blue hour ends',
]

export function lyricsFor(trackId: string): Lyrics | null {
  if (trackId !== track('night-swimming').id) return null
  const step = 224 / (nightSwimming.length + 2)
  const synced = nightSwimming.map((line, index) => {
    const at = step * (index + 1)
    return `[${String(Math.floor(at / 60)).padStart(2, '0')}:${(at % 60).toFixed(2).padStart(5, '0')}] ${line}`
  }).join('\n')
  return { trackId, synced, plain: nightSwimming.join('\n'), instrumental: false, source: 'embedded' }
}
