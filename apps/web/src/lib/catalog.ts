import type { AlbumDetail, User } from '@squirmy/contracts'

// What plays and how it looks is one rule shared with the iOS app, so the two cannot drift.
export {
  albumNote, albumPresentation, albumTypeLabel, canFetch, isPlayable, librarySave, releaseSubtitle, UNAVAILABLE_LABEL, type Viewer,
} from '@squirmy/client-core'

/**
 * An album whose songs the server is still looking up: it said so (`detailPending`), or it is
 * one it fetches and no songs are known yet. Its page shows the list as loading.
 */
export function awaitsTrackList(album: Pick<AlbumDetail, 'discs' | 'detailPending' | 'availability'>): boolean {
  return album.discs.every(disc => !disc.tracks.length) && (Boolean(album.detailPending) || album.availability === 'on_demand')
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
