/**
 * Bridges from Deezer ids to MusicBrainz ids, most reliable source first. A bridge that
 * is not sure answers null: a provider-only page is better than the wrong album.
 */
import type { AlbumType } from '@squirmy/contracts'
import { matchKey } from '../../lib/text.js'
import { deezer, musicbrainz } from '../metadata/index.js'
import type { MbArtistSummary, MbReleaseGroupSummary } from '../metadata/musicbrainz.js'

/** Search hits below this MusicBrainz score are never accepted. */
const minScore = 90

/** "(Remastered)", "[Deluxe Edition]" and the like, which Deezer adds to titles and MusicBrainz keeps out of them. */
const editionSuffix = /\s*[([][^)\]]*\b(remaster(ed)?|deluxe|expanded|anniversary|edition|bonus)\b[^)\]]*[)\]]\s*$/i

const titleKey = (title: string) => matchKey(title.replace(editionSuffix, ''))

/**
 * The one release group a search confidently names: a hit scoring at least 90 whose title
 * (ignoring edition suffixes) and artist equal the wanted ones. Several such hits are
 * narrowed by album type; if that leaves more than one, nothing is accepted.
 */
export function confidentReleaseGroup(hits: readonly MbReleaseGroupSummary[], wanted: { title: string; artist: string; type?: AlbumType }): string | null {
  const artist = matchKey(wanted.artist)
  const exact = hits.filter((hit) => (hit.score ?? 0) >= minScore
    && titleKey(hit.title) === titleKey(wanted.title)
    && (matchKey(hit.artistName) === artist || matchKey(hit.artistCredit[0]?.name ?? '') === artist))
  if (exact.length === 1) return exact[0]!.mbid
  const typed = exact.filter((hit) => hit.type === wanted.type)
  return typed.length === 1 ? typed[0]!.mbid : null
}

/** The one artist a name search confidently names: the only hit scoring at least 90 with exactly that name. */
export function confidentArtist(hits: readonly MbArtistSummary[], name: string): string | null {
  const exact = hits.filter((hit) => (hit.score ?? 0) >= minScore && matchKey(hit.name) === matchKey(name))
  return exact.length === 1 ? exact[0]!.mbid : null
}

/**
 * The MusicBrainz release group of a Deezer album: the release linked to its Deezer page,
 * else the releases carrying its UPC (when they all belong to one group), else a strict
 * title and artist search. Null when none is sure.
 */
export async function bridgeAlbum(deezerId: string, fallback: { title: string; artist: string; type?: AlbumType }): Promise<string | null> {
  const links = await musicbrainz.lookupUrl(`https://www.deezer.com/album/${deezerId}`)
  const linkedGroups = new Set(links?.releaseGroups.map((group) => group.mbid))
  if (linkedGroups.size === 0 && links?.releases[0]) {
    const release = await musicbrainz.getRelease(links.releases[0].mbid)
    if (release) linkedGroups.add(release.releaseGroup.mbid)
  }
  if (linkedGroups.size === 1) return [...linkedGroups][0]!

  const album = await deezer.getAlbum(Number(deezerId))
  if (album?.upc) {
    const groups = new Set((await musicbrainz.findReleasesByBarcode(album.upc)).flatMap((release) => release.releaseGroup ? [release.releaseGroup.mbid] : []))
    if (groups.size === 1) return [...groups][0]!
  }

  const wanted = album ? { title: album.title, artist: album.artist.name, type: album.type } : fallback
  return confidentReleaseGroup(await musicbrainz.searchReleaseGroups(wanted, { limit: 5 }), wanted)
}

/** The MusicBrainz artist of a Deezer artist: the one linked to its Deezer page, else an unambiguous exact-name search. */
export async function bridgeArtist(deezerId: string, name: string): Promise<string | null> {
  const links = await musicbrainz.lookupUrl(`https://www.deezer.com/artist/${deezerId}`)
  const linked = new Set(links?.artists.map((artist) => artist.mbid))
  if (linked.size === 1) return [...linked][0]!
  return confidentArtist(await musicbrainz.searchArtists(name, { limit: 5 }), name)
}
