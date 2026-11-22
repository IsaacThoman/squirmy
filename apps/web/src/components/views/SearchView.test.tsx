import { ApiError, recentSearchesStorageKey } from '@squirmy/client-core'
import type { SearchKind, SearchResults } from '@squirmy/contracts'
import { act, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useLocation } from 'react-router'
import { afterEach, describe, expect, it } from 'vitest'
import { AppRoutes } from '@/App'
import { artists, searchFixtures, searchPage, track } from '@/fixtures/catalog'
import { currentUser } from '@/fixtures/server'
import { fakeServices } from '@/test/fake-services'
import { renderWithApp } from '@/test/render'

function Where() {
  const location = useLocation()
  return <output data-testid="where">{location.pathname + location.search}</output>
}

const field = () => screen.getByRole('combobox', { name: 'Search' })
const results = () => screen.findByRole('listbox', { name: /^Results for/ })
/** Each row's title and "Kind · Artist" line. */
const rows = () => within(screen.getByRole('listbox', { name: /^Results for/ })).getAllByRole('option')
  .map(option => [...option.querySelectorAll('span[dir=auto]')].map(span => span.textContent).join(' — '))
const recentKey = recentSearchesStorageKey(currentUser.id)
type Params = { q: string; type?: SearchKind; offset?: number; limit?: number }

/** A search whose catalog answer waits until the test lets it through. */
function withSlowCatalog() {
  const fake = fakeServices()
  let release = () => {}
  fake.api.search.catalog.mockImplementation((params: Params) => new Promise(resolve => { release = () => resolve(searchPage(searchFixtures(params.q).catalog, params)) }))
  return { ...fake, release: () => act(() => release()) }
}

afterEach(() => localStorage.clear())

describe('search page', () => {
  it('lists every kind in one ranked list, each row saying what it is, with no sections', async () => {
    renderWithApp(<AppRoutes />, '/search?q=mira%20vale')
    await results()
    await waitFor(() => expect(rows()[0]).toBe('Mira Vale — Artist'))
    expect(rows().some(row => row.includes('Album · Mira Vale'))).toBe(true)
    expect(rows().some(row => row.includes('Song · Mira Vale'))).toBe(true)
    expect(screen.queryByRole('heading', { name: /Top result|Artists|Albums|Songs/ })).toBeNull()
    expect(document.body.textContent).not.toMatch(/in your library|more to discover|deezer/i)
    expect(within(screen.getByRole('group', { name: 'Show' })).getAllByRole('button').map(button => button.textContent))
      .toEqual(['All', 'Songs', 'Albums', 'Artists', 'Playlists'])
  })

  it('opens an artist or an album from its row', async () => {
    renderWithApp(<AppRoutes />, '/search?q=mira%20vale')
    await results()
    await userEvent.click(await screen.findByRole('link', { name: 'Mira Vale, Artist' }))
    expect(await screen.findByRole('heading', { level: 1, name: 'Mira Vale' })).toBeInTheDocument()
  })

  it('plays a song with the songs found after it, and pauses it once it is the current track', async () => {
    const { services, socket } = fakeServices()
    renderWithApp(<AppRoutes />, '/search?q=blue', services)
    await results()
    const songs = rows().filter(row => row.includes('Song ·')).map(row => row.split(' — ')[0])
    expect(songs.length).toBeGreaterThan(1)
    await userEvent.click(screen.getByRole('button', { name: `Play ${songs[0]}` }))
    await waitFor(() => expect(socket.session.queue.length).toBeGreaterThan(1))
    await userEvent.click(await screen.findByRole('button', { name: `Pause ${songs[0]}` }))
    expect(await screen.findByRole('button', { name: `Play ${songs[0]}` })).toBeInTheDocument()
  })

  it('opens the best match with Enter, or the row picked with the arrow keys', async () => {
    renderWithApp(<><AppRoutes /><Where /></>, '/search?q=mira%20vale')
    await results()
    await waitFor(() => expect(rows()[0]).toBe('Mira Vale — Artist'))
    await userEvent.type(field(), '{ArrowDown}{ArrowDown}')
    const picked = screen.getByRole('option', { selected: true })
    expect(field()).toHaveAttribute('aria-activedescendant', picked.id)
    expect(picked.textContent).toContain(rows()[1]!.split(' — ')[0])
    await userEvent.type(field(), '{ArrowUp}{Enter}')
    expect(screen.getByTestId('where').textContent).toMatch(/^\/artist\//)
  })

  it('narrows to one kind with a filter, kept in the address, and pages through it', async () => {
    const { services, api } = fakeServices()
    // Thirty songs: a full page, so there may be another.
    const many = Array.from({ length: 30 }, (_, n) => ({ ...track('amber'), id: `00000000-0000-4000-8f00-${String(n).padStart(12, '0')}`, title: `Blue ${n}` }))
    api.search.library.mockImplementation(async (params: Params) => (params.type === 'track'
      ? { artists: [], albums: [], tracks: params.offset ? [] : many, provider: null } satisfies SearchResults
      : searchPage(searchFixtures(params.q).library, params)))
    renderWithApp(<><AppRoutes /><Where /></>, '/search?q=blue', services)
    await results()
    await userEvent.click(screen.getByRole('button', { name: 'Songs' }))
    expect(screen.getByTestId('where').textContent).toBe('/search?q=blue&type=track')
    expect(screen.getByRole('button', { name: 'Songs' })).toHaveAttribute('aria-pressed', 'true')
    await waitFor(() => expect(rows()).toHaveLength(30 + searchFixtures('blue').catalog.tracks.length))
    expect(rows().every(row => row.includes('Song ·'))).toBe(true)
    expect(api.search.library).toHaveBeenCalledWith({ q: 'blue', limit: 30, type: 'track', offset: 0 }, expect.anything())
    expect(api.search.catalog).toHaveBeenCalledWith({ q: 'blue', limit: 30, type: 'track', offset: 0 }, expect.anything())
    await userEvent.click(await screen.findByRole('button', { name: 'Show more' }))
    await waitFor(() => expect(api.search.library).toHaveBeenCalledWith({ q: 'blue', limit: 30, type: 'track', offset: 30 }, expect.anything()))
    await userEvent.click(screen.getByRole('button', { name: 'All' }))
    expect(screen.getByTestId('where').textContent).toBe('/search?q=blue')
  })

  it('keeps a filter to its kind, and ends its pages, with a server that ignores both', async () => {
    const { services, api } = fakeServices()
    // An older server: every kind, the same first page whatever the offset, thirty songs to it.
    const many = Array.from({ length: 30 }, (_, n) => ({ ...track('amber'), id: `00000000-0000-4000-8f00-${String(n).padStart(12, '0')}`, title: `Blue ${n}` }))
    api.search.library.mockImplementation(async (params: Params) => ({ ...searchFixtures(params.q).library, tracks: many, ranked: undefined }))
    api.search.catalog.mockImplementation(async (params: Params) => ({ ...searchFixtures(params.q).catalog, ranked: undefined }))
    renderWithApp(<AppRoutes />, '/search?q=blue&type=track', services)
    await waitFor(() => expect(rows().length).toBeGreaterThan(29))
    expect(rows().every(row => row.includes('Song ·'))).toBe(true)
    await userEvent.click(await screen.findByRole('button', { name: 'Show more' }))
    await waitFor(() => expect(api.search.library).toHaveBeenCalledWith(expect.objectContaining({ offset: 30 }), expect.anything()))
    expect(await screen.findByRole('listbox', { name: /^Results for/ })).toBeInTheDocument()
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Show more' })).toBeNull())
  })

  it('lists the user’s playlists whose name matches under Playlists', async () => {
    renderWithApp(<AppRoutes />, '/search?type=playlist&q=late')
    await results()
    expect(rows()).toEqual(['Late Train — Playlist · alex'])
  })

  it('waits a moment for the catalog, then shows the library alone and adds the catalog where it ranks', async () => {
    const { services, api, release } = withSlowCatalog()
    renderWithApp(<AppRoutes />, '/search?q=mira%20vale', services)
    await waitFor(() => expect(api.search.catalog).toHaveBeenCalled())
    expect(screen.getByRole('status', { name: 'Searching' })).toBeInTheDocument()
    await results()
    const first = rows()
    expect(screen.getByText('Searching for more…')).toBeInTheDocument()
    release()
    await waitFor(() => expect(rows().length).toBeGreaterThan(first.length))
    expect(screen.queryByText('Searching for more…')).toBeNull()
  })

  it('keeps the last results, faded, until the next query is answered, and never mixes the two', async () => {
    const { services, api } = fakeServices()
    renderWithApp(<AppRoutes />, '/search?q=blue%20hour', services)
    await results()
    const before = rows()
    api.search.library.mockReturnValue(new Promise<never>(() => {}))
    api.search.catalog.mockReturnValue(new Promise<never>(() => {}))
    await userEvent.clear(field())
    await userEvent.type(field(), 'amber')
    await waitFor(() => expect(api.search.library).toHaveBeenLastCalledWith({ q: 'amber', limit: 20 }, expect.anything()))
    expect(rows()).toEqual(before)
    expect(screen.getAllByRole('option')[0]).toHaveClass('opacity-60')
    // Enter does not open a result of the earlier query.
    await userEvent.type(field(), '{Enter}')
    expect(screen.getByRole('heading', { level: 1, name: 'Search' })).toBeInTheDocument()
  })

  it('says when nothing matches', async () => {
    renderWithApp(<AppRoutes />, '/search?q=zzzz')
    expect(await screen.findByText('No results for “zzzz”')).toBeInTheDocument()
  })

  it('says when search failed, and tries again', async () => {
    const { services, api } = fakeServices()
    api.search.library.mockRejectedValue(new ApiError(500, 'internal', 'Down'))
    api.search.catalog.mockRejectedValue(new ApiError(500, 'internal', 'Down'))
    renderWithApp(<AppRoutes />, '/search?q=amber', services)
    expect(await screen.findByText('Search didn’t work', {}, { timeout: 4000 })).toBeInTheDocument()
    api.search.library.mockImplementation(async (params: Params) => searchPage(searchFixtures(params.q).library, params))
    api.search.catalog.mockImplementation(async (params: Params) => searchPage(searchFixtures(params.q).catalog, params))
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await results()).toBeInTheDocument()
  })

  it('lists the server’s music alone when the catalog cannot be searched', async () => {
    const { services, api } = fakeServices()
    api.search.catalog.mockRejectedValue(new ApiError(502, 'provider_unavailable', 'Down'))
    renderWithApp(<AppRoutes />, '/search?q=mira%20vale', services)
    expect(await screen.findByText(/the catalog could not be searched/, {}, { timeout: 4000 })).toBeInTheDocument()
    expect(rows()[0]).toBe('Mira Vale — Artist')
  })

  it('remembers what was searched and opened, and offers it before anything is typed', async () => {
    renderWithApp(<><AppRoutes /><Where /></>, '/search?q=mira%20vale')
    await results()
    await userEvent.click(await screen.findByRole('link', { name: 'Mira Vale, Artist' }))
    await screen.findByRole('heading', { level: 1, name: 'Mira Vale' })
    expect(JSON.parse(localStorage.getItem(recentKey)!)).toEqual([{ type: 'artist', artist: artists[0] }, { type: 'query', query: 'mira vale' }])
  })

  it('removes recent searches one by one or all at once, and searches one again', async () => {
    localStorage.setItem(recentKey, JSON.stringify([{ type: 'query', query: 'amber' }, { type: 'query', query: 'tate' }, { type: 'artist', artist: artists[1] }]))
    renderWithApp(<><AppRoutes /><Where /></>, '/search')
    const recent = await screen.findByRole('listbox', { name: 'Recent searches' })
    expect(within(recent).getAllByRole('option')).toHaveLength(3)
    expect(screen.getByText('Recently viewed')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Remove tate from recent searches' }))
    expect(within(recent).getAllByRole('option')).toHaveLength(2)
    await userEvent.click(screen.getByRole('button', { name: 'amber' }))
    expect(screen.getByTestId('where').textContent).toBe('/search?q=amber')
    expect(field()).toHaveValue('amber')
    await userEvent.clear(field())
    await userEvent.click(await screen.findByRole('button', { name: 'Clear all' }))
    expect(screen.queryByRole('listbox', { name: 'Recent searches' })).toBeNull()
    expect(localStorage.getItem(recentKey)).toBeNull()
  })
})
