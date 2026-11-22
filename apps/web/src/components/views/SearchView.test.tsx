import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { AppRoutes } from '@/App'
import { album } from '@/fixtures/catalog'
import { renderWithApp } from '@/test/render'

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

  it('pauses and resumes its song once it is the current track', async () => {
    renderWithApp(<AppRoutes />, '/search?q=amber')
    const top = await screen.findByRole('region', { name: 'Top result' })
    await userEvent.click(within(top).getByRole('button', { name: 'Play Amber' }))
    await userEvent.click(await within(top).findByRole('button', { name: 'Pause Amber' }))
    expect(await within(top).findByRole('button', { name: 'Play Amber' })).toBeInTheDocument()
  })

  it('shows no top result when nothing is named as asked', async () => {
    renderWithApp(<AppRoutes />, '/search?q=soft')
    await screen.findByRole('region', { name: 'In your library' })
    expect(screen.queryByRole('region', { name: 'Top result' })).toBeNull()
  })
})
