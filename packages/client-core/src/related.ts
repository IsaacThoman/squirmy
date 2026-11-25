import type { AlbumSummary, ArtistDetail } from '@squirmy/contracts'

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
export function relatedAlbums(album: Pick<AlbumSummary, 'id' | 'title'>, artist: Pick<ArtistDetail, 'mbid' | 'albums'> | undefined, limit = 12): { versions: AlbumSummary[]; more: AlbumSummary[] } {
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

