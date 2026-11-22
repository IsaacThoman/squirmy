import { ARTIST_SECTION_KEYS, type AlbumDetail, type AlbumSummary, type ArtistDetail, type ArtistSectionKey, type User } from '@squirmy/contracts'

// What plays and how it looks is one rule shared with the iOS app, so the two cannot drift.
export {
  albumNote, albumPresentation, albumTypeLabel, canFetch, isPlayable, librarySave, releaseSubtitle, UNAVAILABLE_LABEL, type Viewer,
} from '@squirmy/client-core'

/** The headings of an artist page's sections. */
const sectionTitles: Record<ArtistSectionKey, string> = {
  album: 'Albums', mixtape: 'Mixtapes', ep: 'EPs', single: 'Singles', live: 'Live albums', compilation: 'Compilations',
  soundtrack: 'Soundtracks', other: 'Other releases', appears_on: 'Appears on',
}

export const isArtistSectionKey = (key: string): key is ArtistSectionKey => (ARTIST_SECTION_KEYS as readonly string[]).includes(key)

/** A section's heading in the app's words; a key a newer server adds shows the server's own title. */
export const artistSectionTitle = (key: string, title = key) => (isArtistSectionKey(key) ? sectionTitles[key] : title)

/** Where "See all" leads for one section of an artist page. */
export const artistReleasesPath = (artistId: string, section: ArtistSectionKey) => `/artist/${artistId}/releases/${section}`

/**
 * An album whose songs the server is still looking up: it said so (`detailPending`) and none
 * are known yet. Its page shows the list as loading. An album the server answers for without
 * songs and without saying it is looking is one whose songs nobody knows; it says so rather
 * than load forever.
 */
export function awaitsTrackList(album: Pick<AlbumDetail, 'discs' | 'detailPending'>): boolean {
  return album.discs.every(disc => !disc.tracks.length) && Boolean(album.detailPending)
}

/** MusicBrainz's "Various Artists": its discography is every compilation, not more of anyone's. */
const VARIOUS_ARTISTS_MBID = '89ad4ac3-39f7-470e-963a-56509c546377'

/**
 * A title with its edition left out, for telling versions of one album apart from other
 * albums: "Watch The Throne (Deluxe)", "Watch the Throne - Remastered" and "Watch The Throne"
 * share one.
 */
export function albumTitleKey(title: string): string {
  let base = title.trim()
  for (let previous = ''; previous !== base;) {
    previous = base
    base = base
      .replace(/\s*[([{][^()[\]{}]*[)\]}]\s*$/u, '')
      .replace(/\s+[-–—:]\s+[^-–—:]*\b(edition|version|remaster(ed)?|deluxe|expanded|anniversary|reissue|mono|stereo|bonus)\b[^-–—:]*$/iu, '')
  }
  const key = (base || title).normalize('NFKD').replace(/\p{M}/gu, '').toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
  // A title of only punctuation ("!!!") keeps it, or every such title would be one album.
  return key || title.trim().toLocaleLowerCase()
}

const kindOrder: AlbumSummary['type'][] = ['album', 'ep', 'live', 'compilation', 'soundtrack', 'other', 'single']

/**
 * What an album page shows after its songs, from its lead artist's discography: other
 * versions of the album (deluxe, remastered, live), then more of the artist's releases, albums
 * and EPs before singles, newest first within each, at most `limit`. "More" shows each of
 * the other albums once, by its plainest title ("Random Access Memories" rather than its
 * drumless edition). Nothing for Various Artists.
 */
export function relatedAlbums(album: Pick<AlbumSummary, 'id' | 'title'>, artist: Pick<ArtistDetail, 'mbid' | 'albums'> | undefined, limit = 12) {
  if (!artist || artist.mbid === VARIOUS_ARTISTS_MBID) return { versions: [], more: [] }
  const key = albumTitleKey(album.title)
  const others = artist.albums.filter(other => other.id !== album.id)
  const versions = others.filter(other => albumTitleKey(other.title) === key)
  const plainest = new Map<string, { other: AlbumSummary; index: number }>()
  others.forEach((other, index) => {
    const otherKey = albumTitleKey(other.title)
    if (otherKey === key) return
    const kept = plainest.get(otherKey)
    if (!kept || other.title.length < kept.other.title.length) plainest.set(otherKey, { other, index })
  })
  const more = [...plainest.values()]
    .sort((a, b) => kindOrder.indexOf(a.other.type) - kindOrder.indexOf(b.other.type) || a.index - b.index)
    .slice(0, limit)
    .map(({ other }) => other)
  return { versions, more }
}

/** Admins, and members with "can upload", may add music through the server. */
export function canUploadMusic(user: Pick<User, 'role' | 'canUpload'>) {
  return user.role === 'admin' || user.canUpload
}

/** Tile colors for genres, picked by name so a genre keeps its color. */
const genreColors = ['#344763', '#5a342a', '#4a4d71', '#5f404b', '#334e48', '#64342e', '#644936', '#543553', '#3f4854', '#60464f', '#4d324b', '#54523d']

export function genreColor(name: string) {
  let hash = 0
  for (const char of name.toLowerCase()) hash = (hash * 31 + char.charCodeAt(0)) | 0
  return genreColors[Math.abs(hash) % genreColors.length]
}
