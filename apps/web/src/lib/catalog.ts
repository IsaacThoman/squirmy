import type { AlbumSummary, TrackSummary, User } from '@squirmy/contracts'

const albumTypes: Record<AlbumSummary['type'], string> = {
  album: 'Album', ep: 'EP', single: 'Single', compilation: 'Compilation', live: 'Live', soundtrack: 'Soundtrack', other: 'Release',
}

export function albumTypeLabel(type: AlbumSummary['type']) {
  return albumTypes[type]
}

/** True when nothing on the album can be played from the server right now. */
export function isUnowned(album: Pick<AlbumSummary, 'availability'>) {
  return album.availability === 'none' || album.availability === 'on_demand'
}

/** Admins, and members with "can acquire", may have the server fetch music on demand. */
export function canRequestMusic(user: Pick<User, 'role' | 'canAcquire'>) {
  return user.role === 'admin' || user.canAcquire
}

/** Admins, and members with "can upload", may add music through the server. */
export function canUploadMusic(user: Pick<User, 'role' | 'canUpload'>) {
  return user.role === 'admin' || user.canUpload
}

/** On the server, or on demand for someone who may request it. */
export function isPlayable(track: Pick<TrackSummary, 'availability'>, canRequest: boolean) {
  return track.availability === 'server' || (track.availability === 'on_demand' && canRequest)
}

/** Tile colors for genres, picked by name so a genre keeps its color. */
const genreColors = ['#344763', '#5a342a', '#4a4d71', '#5f404b', '#334e48', '#64342e', '#644936', '#543553', '#3f4854', '#60464f', '#4d324b', '#54523d']

export function genreColor(name: string) {
  let hash = 0
  for (const char of name.toLowerCase()) hash = (hash * 31 + char.charCodeAt(0)) | 0
  return genreColors[Math.abs(hash) % genreColors.length]
}
