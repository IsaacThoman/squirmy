import { creditParts } from '@squirmy/client-core'
import type { TrackSummary } from '@squirmy/contracts'
import { Fragment } from 'react'
import { cn } from '@/lib/utils'
import { PrefetchLink } from './PrefetchLink'

/** What a credit is made of: its display string and the artists it names. Tracks and albums both have it. */
export type Credited = Pick<TrackSummary, 'artistCredit' | 'artists'>

/**
 * A track's or album's credit as written ("Thundercat feat. Tame Impala"), each artist in it a
 * link to their page. Rows, the player and album headers all draw credits with this, and the
 * plain-text places (the queue, cards, the tab title) show the same `artistCredit`, so every
 * surface reads alike. `plain` leaves out the hover color, for rows that are grayed out;
 * `onNavigate` runs as one is followed (to close a dialog). `focusable` says, by its place among
 * the links, which stay in the Tab order: a row leaves out those its ellipsis cuts, which its menu
 * offers instead.
 */
export function ArtistLinks({ credit, plain = false, focusable, onNavigate }: { credit: Credited; plain?: boolean; focusable?: (index: number) => boolean; onNavigate?: () => void }) {
  const parts = creditParts(credit.artistCredit, credit.artists)
  // Each link's place among the links, skipping the words between them ("feat.", "&").
  const order = (index: number) => parts.slice(0, index).filter(part => part.artist).length
  return (
    <>
      {parts.map((part, index) => (
        <Fragment key={index}>
          {part.artist
            ? <PrefetchLink kind="artist" id={part.artist.id} to={`/artist/${part.artist.id}`} tabIndex={!focusable || focusable(order(index)) ? undefined : -1} onClick={onNavigate} className={cn('hover:underline', !plain && 'hover:text-foreground')}>{part.text}</PrefetchLink>
            : part.text}
        </Fragment>
      ))}
    </>
  )
}
