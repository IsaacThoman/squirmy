/**
 * Subsonic ids are strings. Each carries a prefix naming what it points at, so one
 * parameter (star's `id`, getCoverArt's `id`) can take any kind and a wrong kind is
 * caught on the way in. Folder browsing reuses the same ids: an artist is the folder of
 * its albums, an album the folder of its songs.
 *
 *   ar-<uuid>  artist          al-<uuid>  album (release group)
 *   tr-<uuid>  track (recording)   pl-<uuid>  playlist
 *   ca-<uuid>  cover art (an artwork asset)
 *
 * Music folders are library roots; the specification types their ids as integers, so
 * each root gets a stable number derived from its uuid.
 */
import { createHash } from 'node:crypto'
import { notFound } from './protocol.js'

export type IdKind = 'artist' | 'album' | 'track' | 'playlist' | 'cover'

const prefixes: Record<IdKind, string> = { artist: 'ar', album: 'al', track: 'tr', playlist: 'pl', cover: 'ca' }
const kinds = new Map(Object.entries(prefixes).map(([kind, prefix]) => [prefix, kind as IdKind]))
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const nouns: Record<IdKind, string> = { artist: 'Artist', album: 'Album', track: 'Song', playlist: 'Playlist', cover: 'Cover art' }

export const artistId = (id: string) => `ar-${id}`
export const albumId = (id: string) => `al-${id}`
export const trackId = (id: string) => `tr-${id}`
export const playlistId = (id: string) => `pl-${id}`
export const coverArtId = (assetId: string) => `ca-${assetId}`

export type ParsedId = { kind: IdKind; id: string }

/** The kind and uuid of a Subsonic id; null when it is not one of ours. */
export function parseId(value: string): ParsedId | null {
  const dash = value.indexOf('-')
  const kind = kinds.get(value.slice(0, dash))
  const id = value.slice(dash + 1)
  return dash > 0 && kind && uuid.test(id) ? { kind, id: id.toLowerCase() } : null
}

/** Parses an id that must be one of `allowed`; anything else cannot exist, so it is error 70. */
export function expectId<Kind extends IdKind>(value: string, ...allowed: Kind[]): { kind: Kind; id: string } {
  const parsed = parseId(value.trim())
  if (!parsed || !allowed.includes(parsed.kind as Kind)) throw notFound(nouns[allowed[0]!])
  return parsed as { kind: Kind; id: string }
}

/** The integer music folder id of a library root. 31 bits, so every client's int type holds it. */
export function folderId(rootId: string): number {
  return Number.parseInt(createHash('sha256').update(rootId).digest('hex').slice(0, 8), 16) & 0x7fffffff
}
