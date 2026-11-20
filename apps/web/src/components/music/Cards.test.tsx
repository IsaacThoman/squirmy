import { screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { album, summary } from '@/fixtures/catalog'
import { renderWithApp } from '@/test/render'
import { AlbumCard } from './Cards'

describe('AlbumCard availability', () => {
  it('lights an owned album and offers play', () => {
    renderWithApp(<AlbumCard album={summary(album('glass-city'))} onPlay={() => {}} />)
    expect(screen.getByRole('button', { name: 'Play Glass City' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Glass City' })).not.toHaveClass('text-quiet')
  })

  it('counts owned tracks on a partial album', () => {
    renderWithApp(<AlbumCard album={summary(album('blue-hour'))} onPlay={() => {}} />)
    expect(screen.getByText('5 of 7')).toBeInTheDocument()
  })

  it('grays out an album that is not in the library and hides play', () => {
    const { container } = renderWithApp(<AlbumCard album={summary(album('live-glasshouse'))} onPlay={() => {}} />)
    expect(screen.queryByRole('button', { name: /Play/ })).toBeNull()
    expect(screen.getByRole('link', { name: 'Live at the Glasshouse' })).toHaveClass('text-quiet')
    expect(container.querySelector('.grayscale')).not.toBeNull()
  })

  it('marks an on-demand album', () => {
    renderWithApp(<AlbumCard album={summary(album('low-tide'))} onPlay={() => {}} />)
    expect(screen.getByLabelText('Plays on demand')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Play Low Tide' })).toBeNull()
  })
})
