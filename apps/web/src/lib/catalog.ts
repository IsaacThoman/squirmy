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
