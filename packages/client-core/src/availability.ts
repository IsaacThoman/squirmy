import type { AlbumSummary, TrackSummary, User } from '@squirmy/contracts'

/**
 * The parts of a user that decide what they can play. Null or undefined (signed out, or
 * not loaded yet) counts as someone who may not fetch, so nothing looks playable that
 * would then fail.
 */
export type Viewer = Pick<User, 'role' | 'canAcquire'>

/** The one word unavailable music carries, on hover, long-press and for screen readers. */
export const UNAVAILABLE_LABEL = 'Not available'

/**
 * Whether the server fetches music for this user when they play it: admins always, members
 * with `canAcquire`. These are the "requesters" of the presentation rules.
 */
export function canFetch(user: Viewer | null | undefined): boolean {
  return !!user && (user.role === 'admin' || user.canAcquire)
}

/**
 * The single rule every surface uses: a file on the server plays for everyone, `on_demand`
 * plays for a requester, and nothing else plays. A playable track looks the same wherever
 * its file is.
 */
export function isPlayable(track: Pick<TrackSummary, 'availability'>, viewer: Viewer | null | undefined): boolean {
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
