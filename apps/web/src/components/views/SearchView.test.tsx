import { act, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useLocation } from 'react-router'
import { describe, expect, it } from 'vitest'
import { AppRoutes } from '@/App'
import { album, searchFixtures } from '@/fixtures/catalog'
import { fakeServices } from '@/test/fake-services'
import { renderWithApp } from '@/test/render'

function Where() {
  return <output data-testid="where">{useLocation().pathname}</output>
}

const headings = () => screen.getAllByRole('heading', { level: 2 }).map(heading => heading.textContent)
const songs = () => within(screen.getByRole('list', { name: 'Songs' })).getAllByRole('listitem').map(item => item.querySelector('[title]')?.getAttribute('title'))

/** A search whose catalog answer waits until the test lets it through. */
function withSlowCatalog() {
  const fake = fakeServices()
  let release = () => {}
  fake.api.search.catalog.mockImplementation(({ q }: { q: string }) => new Promise(resolve => { release = () => resolve(searchFixtures(q).catalog) }))
  return { ...fake, release: () => act(() => release()) }
}

describe('search page', () => {
  it('shows one set of results: the top result, then artists, albums and songs, with no sections by where music is', async () => {
    renderWithApp(<AppRoutes />, '/search?q=mira%20vale')
    const top = await screen.findByRole('region', { name: 'Top result' })
    expect(within(top).getByText('Artist')).toBeInTheDocument()
    await waitFor(() => expect(headings()).toEqual(['Top result', 'Artists', 'Albums', 'Songs']))
    expect(document.body.textContent).not.toMatch(/in your library|more to discover|deezer/i)
  })

  it('opens an artist from the top result', async () => {
    renderWithApp(<AppRoutes />, '/search?q=mira%20vale')
    const top = await screen.findByRole('region', { name: 'Top result' })
    expect(within(top).queryByRole('button')).toBeNull()
    await userEvent.click(within(top).getByRole('link', { name: 'Mira Vale' }))
    expect(await screen.findByRole('heading', { level: 1, name: 'Mira Vale' })).toBeInTheDocument()
  })

  it('plays an album or a song from the top result', async () => {
    renderWithApp(<AppRoutes />, '/search?q=blue%20hour')
    const top = await screen.findByRole('region', { name: 'Top result' })
    expect(within(top).getByRole('link', { name: 'Blue Hour' })).toHaveAttribute('href', `/album/${album('blue-hour').id}`)
    expect(within(top).getByRole('button', { name: 'Play Blue Hour' })).toBeInTheDocument()
  })

  it('pauses and resumes its song once it is the current track', async () => {
    renderWithApp(<AppRoutes />, '/search?q=amber')
    const top = await screen.findByRole('region', { name: 'Top result' })
    await userEvent.click(within(top).getByRole('button', { name: 'Play Amber' }))
    await userEvent.click(await within(top).findByRole('button', { name: 'Pause Amber' }))
    expect(await within(top).findByRole('button', { name: 'Play Amber' })).toBeInTheDocument()
  })

  it('plays the top result with Enter', async () => {
    const { services, socket } = fakeServices()
    renderWithApp(<AppRoutes />, '/search?q=amber', services)
    await screen.findByRole('region', { name: 'Top result' })
    await userEvent.type(screen.getByRole('searchbox', { name: 'Search' }), '{Enter}')
    await waitFor(() => expect(socket.session.current?.trackId).toBe(searchFixtures('amber').library.tracks[0]!.id))
  })

  it('opens an artist top result with Enter', async () => {
    renderWithApp(<><AppRoutes /><Where /></>, '/search?q=mira%20vale')
    await screen.findByRole('region', { name: 'Top result' })
    await userEvent.type(screen.getByRole('searchbox', { name: 'Search' }), '{Enter}')
    expect(screen.getByTestId('where').textContent).toMatch(/^\/artist\//)
  })

  it('shows the library’s results at once and adds the catalog’s after them, moving none', async () => {
    const { services, api, release } = withSlowCatalog()
    renderWithApp(<AppRoutes />, '/search?q=mira%20vale', services)
    await screen.findByRole('list', { name: 'Songs' })
    await waitFor(() => expect(api.search.catalog).toHaveBeenCalled())
    const first = songs()
    expect(first.length).toBeGreaterThan(0)
    expect(screen.getByRole('list', { name: 'Songs' }).closest('[aria-busy]')).not.toBeNull()
    release()
    await waitFor(() => expect(songs().length).toBeGreaterThan(first.length))
    expect(screen.getByRole('list', { name: 'Songs' }).closest('[aria-busy]')).toBeNull()
    expect(songs().slice(0, first.length)).toEqual(first)
  })

  it('never shows one query’s results under another', async () => {
    const { services, api } = fakeServices()
    renderWithApp(<AppRoutes />, '/search?q=blue%20hour', services)
    await screen.findByRole('region', { name: 'Top result' })
    api.search.library.mockReturnValue(new Promise<never>(() => {}))
    api.search.catalog.mockReturnValue(new Promise<never>(() => {}))
    const field = screen.getByRole('searchbox', { name: 'Search' })
    await userEvent.clear(field)
    await userEvent.type(field, 'amber')
    await waitFor(() => expect(api.search.library).toHaveBeenLastCalledWith({ q: 'amber', limit: 20 }, expect.anything()))
    expect(screen.queryByRole('region', { name: 'Top result' })).toBeNull()
    expect(screen.queryByText('Blue Hour')).toBeNull()
    expect(screen.getByRole('status', { name: 'Searching' })).toBeInTheDocument()
  })

  it('keeps a shorter query’s songs, faded and with no top result, while the answer for more typing is on its way', async () => {
    const { services, api } = fakeServices()
    renderWithApp(<AppRoutes />, '/search?q=blue', services)
    await screen.findByRole('list', { name: 'Songs' })
    api.search.library.mockReturnValue(new Promise<never>(() => {}))
    api.search.catalog.mockReturnValue(new Promise<never>(() => {}))
    await userEvent.type(screen.getByRole('searchbox', { name: 'Search' }), ' hour')
    await waitFor(() => expect(api.search.library).toHaveBeenLastCalledWith({ q: 'blue hour', limit: 20 }, expect.anything()))
    expect(screen.getByRole('list', { name: 'Songs' }).closest('[aria-busy]')).toHaveClass('opacity-60')
    expect(screen.queryByRole('region', { name: 'Top result' })).toBeNull()
  })

  it('says when nothing matches', async () => {
    renderWithApp(<AppRoutes />, '/search?q=zzzz')
    expect(await screen.findByText('No results for “zzzz”')).toBeInTheDocument()
  })
})
