import type { HomeResponse } from '@squirmy/contracts'
import { screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { AppRoutes } from '@/App'
import { album, home, summary, track } from '@/fixtures/catalog'
import { fakeServices } from '@/test/fake-services'
import { renderWithApp } from '@/test/render'

function renderHome(response: HomeResponse) {
  const fake = fakeServices()
  fake.api.catalog.home.mockResolvedValue(response)
  renderWithApp(<AppRoutes />, '/', fake.services)
}

describe('home', () => {
  it('shows the sections in the order the server sends them', async () => {
    const reversed = { sections: [...home.sections].reverse() }
    renderHome(reversed)
    await screen.findByRole('heading', { level: 2, name: reversed.sections[0]!.title })
    const shown = screen.getAllByRole('heading', { level: 2 }).map(heading => heading.textContent).filter(title => reversed.sections.some(section => section.title === title))
    expect(shown).toEqual(reversed.sections.map(section => section.title))
  })

  it('leads with the album played last, even with nothing added', async () => {
    renderHome({ sections: [
      { kind: 'albums', id: 'recently-played', title: 'Recently played', albums: [summary(album('low-tide'))] },
      { kind: 'tracks', id: 'most-played', title: 'Most played', tracks: [track('amber')] },
    ] })
    const featured = await screen.findByRole('region', { name: 'Featured' })
    expect(within(featured).getByText('Jump back in')).toBeInTheDocument()
    expect(within(featured).getByRole('heading', { name: 'Low Tide' })).toBeInTheDocument()
    expect(screen.queryByText('Start listening')).toBeNull()
  })

  it('points a requester at search when there is nothing yet', async () => {
    renderHome({ sections: [{ kind: 'albums', id: 'recently-added', title: 'Recently added', albums: [] }] })
    expect(await screen.findByRole('heading', { name: 'Start listening' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Find music' })).toHaveAttribute('href', '/search')
  })
})

describe('library', () => {
  it('explains what the library holds when it is empty', async () => {
    const fake = fakeServices()
    fake.api.catalog.albums.mockResolvedValue({ items: [], nextCursor: null })
    renderWithApp(<AppRoutes />, '/library/albums', fake.services)
    expect(await screen.findByText(/^Albums you add to your library and music on this server appear here\./)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Find music' })).toHaveAttribute('href', '/search')
  })

  it('lists artists with no sort or genre the server would ignore', async () => {
    renderWithApp(<AppRoutes />, '/library/artists')
    await screen.findByRole('list', { name: 'Artists' })
    expect(screen.queryByRole('combobox', { name: 'Sort by' })).toBeNull()
    expect(screen.queryByRole('combobox', { name: 'Genre' })).toBeNull()
  })
})
