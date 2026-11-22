import type { TrackSummary } from '@squirmy/contracts'
import { Fragment } from 'react'
import { cn } from '@/lib/utils'
import { PrefetchLink } from './PrefetchLink'

/**
 * The track's artists, each a link to its own page. `plain` leaves out the hover color, for rows
 * that are grayed out; `onNavigate` runs as one is followed (to close a dialog).
 */
export function ArtistLinks({ track, plain = false, onNavigate }: { track: TrackSummary; plain?: boolean; onNavigate?: () => void }) {
  if (!track.artists.length) return <>{track.artistCredit}</>
  return (
    <>
      {track.artists.map((artist, index) => (
        <Fragment key={artist.id}>
          {index > 0 && ', '}
          <PrefetchLink kind="artist" id={artist.id} to={`/artist/${artist.id}`} onClick={onNavigate} className={cn('hover:underline', !plain && 'hover:text-foreground')}>{artist.name}</PrefetchLink>
        </Fragment>
      ))}
    </>
  )
}
