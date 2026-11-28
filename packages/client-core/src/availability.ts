import type { AlbumSummary, ArtistDetail, TrackSummary, User } from '@squirmy/contracts'
import { plural } from './format.js'

/**
 * The parts of a user that decide what they can play. Null or undefined (signed out, or
 * not loaded yet) counts as someone who may not fetch, so nothing looks playable that
 * would then fail. `allowsExplicit` left out (a server from before the setting) allows it.
 */
export type Viewer = Pick<User, 'role' | 'canAcquire'> & Partial<Pick<User, 'allowsExplicit'>>

/** The one word unavailable music carries, on hover, long-press and for screen readers. */
export const UNAVAILABLE_LABEL = 'Not available'

/** What an explicit song says instead, for a viewer who has explicit content off. */
export const EXPLICIT_OFF_LABEL = 'Explicit content is off'

/**
 * An explicit song for a viewer who has explicit content off (their setting, or an admin's
 * restriction): gray and never played, whatever its availability. Unknown is not explicit.
 */
export function explicitBlocked(track: { explicit?: boolean | null }, viewer: Viewer | null | undefined): boolean {
  return track.explicit === true && viewer?.allowsExplicit === false
}

/** Why a gray song is gray, in the words every surface uses. */
export function unavailableLabel(track: { explicit?: boolean | null }, viewer: Viewer | null | undefined): string {
  return explicitBlocked(track, viewer) ? EXPLICIT_OFF_LABEL : UNAVAILABLE_LABEL
}

/**
 * Whether the server fetches music for this user when they play it: admins always, members
 * with `canAcquire`. These are the "requesters" of the presentation rules.
 */
export function canFetch(user: Viewer | null | undefined): boolean {
  return !!user && (user.role === 'admin' || user.canAcquire)
}

/**
 * The single rule every surface uses: a file on the server plays for everyone, `on_demand`
 * plays for a requester, and nothing else plays; an explicit song plays for no one who has
 * explicit content off (`explicitBlocked`). A playable track looks the same wherever its
 * file is.
 */
export function isPlayable(track: Pick<TrackSummary, 'availability'> & { explicit?: boolean | null }, viewer: Viewer | null | undefined): boolean {
  if (explicitBlocked(track, viewer)) return false
  return track.availability === 'server' || (track.availability === 'on_demand' && canFetch(viewer))
}

/**
 * How an album card looks: dimmed only when nothing on it would play for this viewer. A
 * `partial` album is never dimmed, since some of it plays for anyone.
 */
export function albumPresentation(album: Pick<AlbumSummary, 'availability'>, viewer: Viewer | null | undefined): 'normal' | 'dimmed' {
  switch (album.availability) {
    case 'full':
    case 'partial':
      return 'normal'
    case 'on_demand':
      return canFetch(viewer) ? 'normal' : 'dimmed'
    case 'none':
      return 'dimmed'
  }
}

/**
 * The one line an album page shows about what is missing: "8 of 13 songs available" for a
 * viewer who cannot fetch the rest. Requesters never see counts, and a fully available or
 * dimmed album needs no line.
 */
export function albumNote(
  album: Pick<AlbumSummary, 'availability' | 'trackCount' | 'ownedTrackCount'>,
  viewer: Viewer | null | undefined,
): string | null {
  if (album.availability !== 'partial' || canFetch(viewer)) return null
  return `${album.ownedTrackCount} of ${album.trackCount} songs available`
}

/** The heart's state and the words of the menu entry that mirrors it. */
export type LibrarySave = { saved: boolean; label: string }

/**
 * The one library control, for a track, album or artist: the heart and the "Save to library" /
 * "Remove from library" menu entry both show and flip `liked`. A collection item (the server's
 * own files) is in everyone's library whatever the heart says; the heart only ever shows the
 * viewer's own save. `saved` is what the viewer just did, ahead of the server's answer.
 */
export function librarySave(item: { liked: boolean }, saved?: boolean): LibrarySave {
  const value = saved ?? item.liked
  return { saved: value, label: value ? 'Remove from library' : 'Save to library' }
}

/**
 * How many of an artist's releases there are, and how many play for a viewer who may not
 * fetch music. A server that predates the counts sends every release in `albums`, so they
 * are counted there.
 */
export function artistReleaseCounts(
  artist: Pick<ArtistDetail, 'albums' | 'releaseCount' | 'ownedReleaseCount'>, viewer: Viewer | null | undefined,
): { total: number; playing: number } {
  if (artist.releaseCount !== undefined && artist.ownedReleaseCount !== undefined) return { total: artist.releaseCount, playing: artist.ownedReleaseCount }
  return { total: artist.albums.length, playing: artist.albums.filter(album => albumPresentation(album, viewer) === 'normal').length }
}

/**
 * Only someone who may not fetch music is told how much of a discography plays: `3 of
 * 12 releases available`. Null when everything plays for this viewer.
 */
export function artistAvailabilityNote(
  artist: Pick<ArtistDetail, 'albums' | 'releaseCount' | 'ownedReleaseCount'>, viewer: Viewer | null | undefined,
): string | null {
  const { total, playing } = artistReleaseCounts(artist, viewer)
  return canFetch(viewer) || playing >= total ? null : `${playing.toLocaleString()} of ${plural(total, 'release')} available`
}
