import type { AlbumSummary } from '@squirmy/contracts'

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

/** Tile colors for genres, picked by name so a genre keeps its color. */
const genreColors = ['#344763', '#5a342a', '#4a4d71', '#5f404b', '#334e48', '#64342e', '#644936', '#543553', '#3f4854', '#60464f', '#4d324b', '#54523d']

export function genreColor(name: string) {
  let hash = 0
  for (const char of name.toLowerCase()) hash = (hash * 31 + char.charCodeAt(0)) | 0
  return genreColors[Math.abs(hash) % genreColors.length]
}
