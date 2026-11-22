import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { AppRoutes } from '@/App'
import { album, albums } from '@/fixtures/catalog'
import { renderWithApp } from '@/test/render'
import { SearchView } from './SearchView'

const sectionHeadings = (section: HTMLElement) => within(section).getAllByRole('heading', { level: 2 }).map(heading => heading.textContent)

describe('search page', () => {
  it('leads with the top result, then artists, albums and songs', async () => {
    renderWithApp(<AppRoutes />, '/search?q=blue%20hour')
    const top = await screen.findByRole('region', { name: 'Top result' })
    expect(within(top).getByRole('link', { name: 'Blue Hour' })).toHaveAttribute('href', `/album/${album('blue-hour').id}`)
    expect(within(top).getByText('Album')).toBeInTheDocument()
    expect(within(top).getByRole('button', { name: 'Play Blue Hour' })).toBeInTheDocument()
    const library = screen.getByRole('region', { name: 'In your library' })
    expect(top.compareDocumentPosition(library) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(sectionHeadings(library)).toEqual(['In your library', 'Albums', 'Songs'])
  })

  it('opens an artist, and orders artists, albums and songs', async () => {
    renderWithApp(<AppRoutes />, '/search?q=mira%20vale')
    const artist = await screen.findByRole('region', { name: 'Top result' })
    expect(within(artist).getByText('Artist')).toBeInTheDocument()
    expect(within(artist).queryByRole('button')).toBeNull()
    expect(sectionHeadings(screen.getByRole('region', { name: 'In your library' }))).toEqual(['In your library', 'Artists', 'Albums', 'Songs'])
    await userEvent.click(within(artist).getByRole('link', { name: 'Mira Vale' }))
    expect(await screen.findByRole('heading', { level: 1, name: 'Mira Vale' })).toBeInTheDocument()
  })

  it('plays an owned song', async () => {
    renderWithApp(<AppRoutes />, '/search?q=amber')
    const top = await screen.findByRole('region', { name: 'Top result' })
    expect(within(top).getByText('Song')).toBeInTheDocument()
    expect(within(top).getByRole('button', { name: 'Play Amber' })).toBeInTheDocument()
  })

  it('shows no top result when nothing is named as asked', async () => {
    renderWithApp(<AppRoutes />, '/search?q=soft')
    await screen.findByRole('region', { name: 'In your library' })
    expect(screen.queryByRole('region', { name: 'Top result' })).toBeNull()
  })

  it('can reveal songs beyond the first six results', async () => {
    const tracks = albums.flatMap(item => item.discs.flatMap(disc => disc.tracks)).slice(0, 8)
    renderWithApp(<SearchView query="a" onQueryChange={() => {}} library={{ artists: [], albums: [], tracks, provider: null }} catalog={null} genres={[]} onBrowseGenre={() => {}} onPlayAlbum={() => {}} />)
    const songs = screen.getByRole('list', { name: 'In your library: songs' })
    expect(within(songs).getAllByRole('listitem')).toHaveLength(6)
    await userEvent.click(screen.getByRole('button', { name: 'Show all 8 songs' }))
    expect(within(songs).getAllByRole('listitem')).toHaveLength(8)
    await userEvent.click(screen.getByRole('button', { name: 'Show fewer songs' }))
    expect(within(songs).getAllByRole('listitem')).toHaveLength(6)
  })
})
