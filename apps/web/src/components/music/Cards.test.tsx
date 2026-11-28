import type { AlbumSummary } from '@squirmy/contracts'
import { fireEvent, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { album, artists, playlistSummaries, summary } from '@/fixtures/catalog'
import { draggedMusic, endTrackDrag } from '@/lib/drag'
import { dataTransfer } from '@/test/data-transfer'
import type { Viewer } from '@/lib/catalog'
import { OnDemandContext } from '@/player/on-demand-context'
import { renderWithApp } from '@/test/render'
import { AlbumCard, AlbumRow, ArtistCard, PlaylistCard } from './Cards'

const requester: Viewer = { role: 'admin', canAcquire: false }
const member: Viewer = { role: 'member', canAcquire: false }

function renderCard(item: AlbumSummary, viewer: Viewer, onWant?: (wanted: boolean) => void) {
  return renderWithApp(<OnDemandContext value={{ viewer }}><AlbumCard album={item} onPlay={() => {}} onWant={onWant} /></OnDemandContext>)
}

// Glass City: full; Blue Hour: partial; Low Tide: on demand; Live at the Glasshouse: none.
const cases = [
  ['full', 'glass-city', 'Glass City', 'normal', 'normal'],
  ['partial', 'blue-hour', 'Blue Hour', 'normal', 'normal'],
  ['on demand', 'low-tide', 'Low Tide', 'normal', 'dimmed'],
  ['none', 'live-glasshouse', 'Live at the Glasshouse', 'dimmed', 'dimmed'],
] as const

describe('AlbumCard', () => {
  describe.each([['a requester', requester, 3], ['a member who may not fetch', member, 4]] as const)('for %s', (_who, viewer, column) => {
    it.each(cases)('shows a %s album as the presentation table says', (_availability, slug, title, ...looks) => {
      const look = looks[column - 3]
      const { container } = renderCard(summary(album(slug)), viewer)
      if (look === 'normal') {
        const link = screen.getByRole('link', { name: title })
        expect(screen.getByRole('button', { name: `Play ${title}` })).toBeInTheDocument()
        expect(link).not.toHaveClass('text-muted-foreground')
        expect(container.querySelector('.grayscale')).toBeNull()
        expect(container).not.toHaveTextContent('Not available')
      } else {
        // Said in words, to the eye and to screen readers, not only by the gray.
        const link = screen.getByRole('link', { name: `${title} (Not available)` })
        expect(screen.queryByRole('button', { name: /^Play/ })).toBeNull()
        expect(link).toHaveClass('text-muted-foreground')
        expect(container.querySelector('.grayscale')).not.toBeNull()
        expect(screen.getByText(/^Not available ·/)).toBeVisible()
        // Faded, the line is a layer over the card's link: it must let a press through to the card.
        expect(screen.getByText(/^Not available ·/).parentElement).toHaveClass('pointer-events-none')
      }
      // Never a badge: no cloud, no "5 of 7".
      expect(screen.queryByLabelText(/on demand/i)).toBeNull()
      expect(container.textContent).not.toMatch(/\d+ of \d+/)
    })
  })

  it('says an album row that would not play is not available, beyond its gray', () => {
    renderWithApp(<OnDemandContext value={{ viewer: member }}><AlbumRow album={summary(album('live-glasshouse'))} onPlay={() => {}} /></OnDemandContext>)
    const link = screen.getByRole('link', { name: /^Live at the Glasshouse \(Not available\)/ })
    expect(link).toHaveTextContent(/Not available · Album/)
    expect(screen.queryByRole('button', { name: /^Play/ })).toBeNull()
  })

  it('offers the Wantlist bookmark only on a dimmed album', () => {
    renderCard(summary(album('low-tide')), requester, () => {})
    expect(screen.queryByRole('button', { name: /Wantlist/ })).toBeNull()
    renderCard(summary(album('low-tide')), member, () => {})
    expect(screen.getByRole('button', { name: 'Add Low Tide to Wantlist' })).toBeInTheDocument()
  })
})

describe('card menus and drags', () => {
  afterEach(endTrackDrag)

  it('opens an artist’s menu from a right-click, with no ⋯ button on the card', async () => {
    const artist = artists[0]!
    renderWithApp(<ArtistCard artist={artist} />)
    expect(screen.queryByRole('button', { name: `More options for ${artist.name}` })).toBeNull()
    fireEvent.contextMenu(screen.getByRole('link', { name: artist.name }))
    expect(await screen.findByRole('menuitem', { name: 'Start radio' })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: 'Go to artist' })).toBeInTheDocument()
  })

  it('opens a playlist’s menu from a right-click: play, queue, add to another playlist, share, open', async () => {
    const playlist = playlistSummaries[0]!
    renderWithApp(<PlaylistCard playlist={playlist} onPlay={() => {}} />)
    fireEvent.contextMenu(screen.getByRole('link', { name: playlist.name }))
    expect((await screen.findAllByRole('menuitem')).map(item => item.textContent)).toEqual(['Play', 'Play next', 'Add to queue', 'Add to playlist', 'Share…', 'Go to playlist'])
  })

  it('carries an album or a playlist when its card is dragged, for the sidebar, the queue and the player', () => {
    const item = summary(album('glass-city'))
    renderWithApp(<AlbumCard album={item} />)
    const transfer = dataTransfer()
    fireEvent.dragStart(screen.getByRole('link', { name: item.title }), { dataTransfer: transfer })
    expect(transfer.getData('application/x-squirmy-collection')).toBe(`album:${item.id}`)
    expect(draggedMusic({ dataTransfer: transfer })).toEqual({ kind: 'collection', collection: { kind: 'album', id: item.id, title: item.title } })
  })
})
