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

/**
 * Deezer tells namesakes apart with a parenthetical ("Nirvana (UK)"), which `matchKey`
 * would read as part of the name and match to MusicBrainz's "Nirvana UK", a tribute band.
 * Returns the name before it and the hint inside it.
 */
export function nameHint(name: string): { base: string; hint: string } | null {
  const match = /^(.*\S)\s*\(([^()]+)\)$/.exec(name.trim())
  return match ? { base: match[1]!, hint: match[2]!.trim() } : null
}

/** Country codes MusicBrainz uses for the hints Deezer writes most. */
const hintCountries: Record<string, string> = { uk: 'GB', gb: 'GB', england: 'GB', us: 'US', usa: 'US', ca: 'CA', au: 'AU', fr: 'FR', de: 'DE', jp: 'JP', kr: 'KR' }

/** Whether a MusicBrainz artist fits a namesake hint: its country, or a disambiguation that says it. */
function fitsHint(hit: MbArtistSummary, hint: string): boolean {
  const key = hint.toLowerCase()
  if (hit.country && (hintCountries[key] ?? hint.toUpperCase()) === hit.country) return true
  return matchKey(hit.disambiguation).split(' ').includes(matchKey(hint))
}

/**
 * The one artist a name search confidently names: the only hit scoring at least 90 with
 * exactly that name. A name with a namesake hint ("Nirvana (UK)") takes a hit of exactly
 * that spelling, else the only hit named like the part before it that fits the hint.
 */
export function confidentArtist(hits: readonly MbArtistSummary[], name: string): string | null {
  const scored = hits.filter((hit) => (hit.score ?? 0) >= minScore)
  const hinted = nameHint(name)
  if (hinted) {
    const spelled = scored.filter((hit) => hit.name.toLowerCase() === name.trim().toLowerCase())
    if (spelled.length === 1) return spelled[0]!.mbid
    const fitting = hits.filter((hit) => matchKey(hit.name) === matchKey(hinted.base) && fitsHint(hit, hinted.hint))
    return fitting.length === 1 ? fitting[0]!.mbid : null
  }
  const exact = scored.filter((hit) => matchKey(hit.name) === matchKey(name))
  return exact.length === 1 ? exact[0]!.mbid : null
}

/** A Deezer album placed in MusicBrainz: its release group, and the release itself when that is known too. */
export type BridgedAlbum = { group: string; release: string | null }

/**
 * The MusicBrainz release group of a Deezer album: the release linked to its Deezer page,
 * else the releases carrying its UPC (when they all belong to one group), else a strict
 * title and artist search. The release is kept when the link or the barcode names one:
 * a deluxe edition is a release of the standard album's group, and the page opened for it
 * must keep showing it. Null when no group is sure.
 */
export async function bridgeAlbum(deezerId: string, fallback: { title: string; artist: string; type?: AlbumType }): Promise<BridgedAlbum | null> {
  const links = await musicbrainz.lookupUrl(`https://www.deezer.com/album/${deezerId}`)
  const linkedGroups = new Set(links?.releaseGroups.map((group) => group.mbid))
  const linkedRelease = links?.releases.length === 1 ? links.releases[0]!.mbid : null
  if (linkedGroups.size === 0 && links?.releases[0]) {
    const release = await musicbrainz.getRelease(links.releases[0].mbid)
    if (release) linkedGroups.add(release.releaseGroup.mbid)
  }
  if (linkedGroups.size === 1) return { group: [...linkedGroups][0]!, release: linkedRelease }

  const album = await deezer.getAlbum(Number(deezerId))
  if (album?.upc) {
    const pressings = await musicbrainz.findReleasesByBarcode(album.upc)
    const groups = new Set(pressings.flatMap((release) => release.releaseGroup ? [release.releaseGroup.mbid] : []))
    if (groups.size === 1) return { group: [...groups][0]!, release: pressings.length === 1 ? pressings[0]!.mbid : null }
  }

  const wanted = album ? { title: album.title, artist: album.artist.name, type: album.type } : fallback
  const group = confidentReleaseGroup(await musicbrainz.searchReleaseGroups(wanted, { limit: 5 }), wanted)
  return group ? { group, release: null } : null
}

/** The MusicBrainz artist of a Deezer artist: the one linked to its Deezer page, else an unambiguous exact-name search. */
export async function bridgeArtist(deezerId: string, name: string): Promise<string | null> {
  const links = await musicbrainz.lookupUrl(`https://www.deezer.com/artist/${deezerId}`)
  const linked = new Set(links?.artists.map((artist) => artist.mbid))
  if (linked.size === 1) return [...linked][0]!
  // A namesake hint is not part of the name MusicBrainz knows the artist by.
  return confidentArtist(await musicbrainz.searchArtists(nameHint(name)?.base ?? name, { limit: 5 }), name)
}
