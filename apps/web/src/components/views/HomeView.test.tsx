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

  it('shows every recently played album in its rail, in server order', async () => {
    renderHome(home)
    const played = home.sections[0]!
    if (played.kind !== 'albums') throw new Error('The fixture leads with recently played albums')
    const rail = await screen.findByRole('region', { name: played.title })
    const cards = within(rail).getAllByRole('link').map(link => link.textContent)
    expect(cards).toEqual(played.albums.map(item => item.title))
    expect(screen.queryByRole('region', { name: 'Featured' })).toBeNull()
  })

  it.each([
    ['recently-played', 'Recently played'],
    ['recently-added', 'Recently added'],
  ])('keeps %s visible when it has only one album', async (id, title) => {
    renderHome({ sections: [
      { kind: 'albums', id, title, albums: [summary(album('low-tide'))] },
      { kind: 'tracks', id: 'most-played', title: 'Most played', tracks: [track('amber')] },
    ] })
    const rail = await screen.findByRole('region', { name: title })
    expect(within(rail).getByRole('link', { name: 'Low Tide' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 2, name: 'Most played' })).toBeInTheDocument()
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
    expect(await screen.findByText(/^Albums and songs you save show up here.*tap the heart\.$/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Find music' })).toHaveAttribute('href', '/search')
  })

  it('lists artists with no sort the server would ignore, and no genre', async () => {
    renderWithApp(<AppRoutes />, '/library/artists')
    await screen.findByRole('list', { name: 'Artists' })
    expect(screen.queryByRole('combobox', { name: 'Sort by' })).toBeNull()
    expect(screen.queryByRole('combobox', { name: 'Genre' })).toBeNull()
  })

  it('links Recently added to the Library’s albums', async () => {
    renderHome(home)
    await screen.findByRole('heading', { level: 2, name: 'Recently added' })
    expect(screen.getAllByRole('link').filter(link => link.getAttribute('href') === '/library?filter=albums')).toHaveLength(1)
  })
})
