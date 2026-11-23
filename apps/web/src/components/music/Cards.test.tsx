import type { AlbumSummary } from '@squirmy/contracts'
import { screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { album, summary } from '@/fixtures/catalog'
import type { Viewer } from '@/lib/catalog'
import { OnDemandContext } from '@/player/on-demand-context'
import { renderWithApp } from '@/test/render'
import { AlbumCard, AlbumRow } from './Cards'

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
