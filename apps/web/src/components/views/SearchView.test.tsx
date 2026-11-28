import { ApiError, recentSearchesStorageKey } from '@squirmy/client-core'
import type { SearchKind, SearchResults } from '@squirmy/contracts'
import { act, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useLocation } from 'react-router'
import { afterEach, describe, expect, it } from 'vitest'
import { AppRoutes } from '@/App'
import { artists, playlistSummaries, searchFixtures, searchPage, track } from '@/fixtures/catalog'
import { currentUser } from '@/fixtures/server'
import { fakeServices } from '@/test/fake-services'
import { renderWithApp } from '@/test/render'

function Where() {
  const location = useLocation()
  return <output data-testid="where">{location.pathname + location.search}</output>
}

const field = () => screen.getByRole('searchbox', { name: 'Search' })
const results = () => screen.findByRole('list', { name: /^Results for/ })
/** The results' rows, not the sidebar's. */
const resultRows = () => within(screen.getByRole('list', { name: /^Results for/ })).getAllByRole('listitem')
/** Each row's title and "Kind · Artist" line. */
const rows = () => resultRows().map(row => [...row.querySelectorAll('span[dir=auto]')].map(span => span.textContent).join(' — '))
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
      .toEqual(['All', 'Songs', 'Albums', 'Artists', 'Playlists', 'Lyrics'])
  })

  it('shows a visible playlist and a lyric snippet returned by the server', async () => {
    const { services, api } = fakeServices()
    const shared = { ...playlistSummaries[0]!, name: 'Harbor Songs', ownerName: 'Another listener', isPublic: true }
    const lyrics = [{ track: track('amber'), snippet: 'A lantern in the harbor' }]
    api.search.library.mockResolvedValue({ artists: [], albums: [], tracks: [], playlists: [shared], lyrics, provider: null })
    api.search.catalog.mockResolvedValue({ artists: [], albums: [], tracks: [], provider: null })
    renderWithApp(<AppRoutes />, '/search?q=harbor', services)
    expect(await screen.findByRole('link', { name: 'Harbor Songs, Playlist · Another listener' })).toBeInTheDocument()
    expect(within(screen.getByRole('list', { name: 'Matching lyrics' })).getByText('A lantern in the harbor')).toBeInTheDocument()
    await userEvent.click(within(screen.getByRole('group', { name: 'Show' })).getByRole('button', { name: 'Lyrics' }))
    expect(await screen.findByText('A lantern in the harbor')).toBeInTheDocument()
    expect(api.search.library).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'lyrics', offset: 0 }), expect.anything())
  })

  it('sends audio quality, decade and liked filters to the library search', async () => {
    const { api, services } = fakeServices()
    renderWithApp(<AppRoutes />, '/search?q=mira&quality=hi-res&decade=1990', services)
    await results()
    expect(api.search.catalog).not.toHaveBeenCalled()
    expect(api.search.library).toHaveBeenCalledWith(expect.objectContaining({ quality: 'hi-res', decade: 1990 }), expect.anything())
    await userEvent.click(screen.getByRole('button', { name: 'Liked only' }))
    await waitFor(() => expect(api.search.library).toHaveBeenLastCalledWith(
      expect.objectContaining({ quality: 'hi-res', decade: 1990, liked: true }), expect.anything(),
    ))
  })

  it('opens an artist or an album from its row', async () => {
    renderWithApp(<AppRoutes />, '/search?q=mira%20vale')
    await results()
    await userEvent.click(await screen.findByRole('link', { name: 'Mira Vale, Artist' }))
    expect(await screen.findByRole('heading', { level: 1, name: 'Mira Vale' })).toBeInTheDocument()
  })

  it('plays a song on its own, for autoplay to follow, and pauses it once it is the current track', async () => {
    const { services, socket } = fakeServices()
    renderWithApp(<AppRoutes />, '/search?q=blue', services)
    await results()
    const songs = rows().filter(row => row.includes('Song ·')).map(row => row.split(' — ')[0])
    // Other songs were found; none of them is queued after the one played.
    expect(songs.length).toBeGreaterThan(1)
    await userEvent.click(screen.getByRole('button', { name: `Play ${songs[0]}` }))
    await waitFor(() => expect(socket.session.current).not.toBeNull())
    expect(socket.session.queue).toEqual([])
    expect(socket.session.playedInCycle).toEqual([])
    expect(socket.session.context).toMatchObject({ type: 'search', title: 'blue' })
    await userEvent.click(await screen.findByRole('button', { name: `Pause ${songs[0]}` }))
    expect(await screen.findByRole('button', { name: `Play ${songs[0]}` })).toBeInTheDocument()
  })

  it('saves an album or an artist to the library from its row\'s menu, as the heart does', async () => {
    const { services, api } = fakeServices()
    renderWithApp(<AppRoutes />, '/search?q=blue%20hour', services)
    await results()
    const row = resultRows().find(option => option.textContent?.startsWith('Blue Hour'))!
    await userEvent.click(within(row).getByRole('button', { name: 'More options for Blue Hour' }))
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Save to library' }))
    await waitFor(() => expect(api.userdata.like).toHaveBeenCalled())
    // No heart on an album's row: the entry says it worked, then the menu closes.
    expect(await screen.findByRole('menuitem', { name: 'Saved to library' })).toBeInTheDocument()
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
    await userEvent.click(within(row).getByRole('button', { name: 'More options for Blue Hour' }))
    expect(await screen.findByRole('menuitem', { name: 'Remove from library' })).toBeInTheDocument()
  })

  it('opens the best match with Enter from the field', async () => {
    renderWithApp(<><AppRoutes /><Where /></>, '/search?q=mira%20vale')
    await results()
    await waitFor(() => expect(rows()[0]).toBe('Mira Vale — Artist'))
    await userEvent.type(field(), '{Enter}')
    expect(screen.getByTestId('where').textContent).toMatch(/^\/artist\//)
  })

  it('moves through the rows with the arrow keys, from the field and back up to it', async () => {
    renderWithApp(<><AppRoutes /><Where /></>, '/search?q=mira%20vale')
    await results()
    await waitFor(() => expect(rows()[0]).toBe('Mira Vale — Artist'))
    field().focus()
    await userEvent.keyboard('{ArrowDown}')
    expect(screen.getByRole('link', { name: 'Mira Vale, Artist' })).toHaveFocus()
    await userEvent.keyboard('{ArrowDown}')
    const second = document.activeElement as HTMLElement
    expect(second).toHaveAttribute('data-search-row')
    expect(resultRows()[1]).toContainElement(second)
    await userEvent.keyboard('{ArrowUp}{ArrowUp}')
    expect(field()).toHaveFocus()
    await userEvent.keyboard('{ArrowDown}{Enter}')
    expect(screen.getByTestId('where').textContent).toMatch(/^\/artist\//)
  })

  it('gives each row one control of its own, its heart and menu beside it rather than inside it', async () => {
    renderWithApp(<AppRoutes />, '/search?q=blue')
    await results()
    expect(field()).not.toHaveAttribute('aria-activedescendant')
    expect(screen.queryAllByRole('option')).toHaveLength(0)
    for (const row of resultRows()) {
      const controls = row.querySelectorAll('[data-search-row]')
      expect(controls).toHaveLength(1)
      expect(within(row).getByRole('button', { name: /^More options for / })).toBeInTheDocument()
    }
    // Every song keeps its heart, whatever the width; its play button is named for what it does and described by its row.
    const song = resultRows().find(row => row.textContent?.includes('Song ·'))!
    expect(within(song).getByRole('button', { name: /^Save .* to library$|^Remove .* from library$/ })).toBeInTheDocument()
    expect(within(song).getByRole('button', { name: /^Play / })).toHaveAccessibleDescription(/^Song · /)
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
    expect(api.search.library).toHaveBeenCalledWith({ q: 'blue', limit: 30, type: 'track', offset: 0, scope: 'server' }, expect.anything())
    expect(api.search.catalog).toHaveBeenCalledWith({ q: 'blue', limit: 30, type: 'track', offset: 0, scope: 'server' }, expect.anything())
    await userEvent.click(await screen.findByRole('button', { name: 'Show more' }))
    await waitFor(() => expect(api.search.library).toHaveBeenCalledWith({ q: 'blue', limit: 30, type: 'track', offset: 30, scope: 'server' }, expect.anything()))
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
    expect(await results()).toBeInTheDocument()
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

  it('keeps the results faded while what is typed on is answered, and never opens one of them with Enter', async () => {
    const { services, api } = fakeServices()
    renderWithApp(<AppRoutes />, '/search?q=blue', services)
    await results()
    const before = rows()
    api.search.library.mockReturnValue(new Promise<never>(() => {}))
    api.search.catalog.mockReturnValue(new Promise<never>(() => {}))
    await userEvent.type(field(), ' hour')
    await waitFor(() => expect(api.search.library).toHaveBeenLastCalledWith({ q: 'blue hour', limit: 20, scope: 'server' }, expect.anything()))
    expect(rows()).toEqual(before)
    expect(resultRows()[0]).toHaveClass('opacity-60')
    // Faded rows are not there to be opened: the list is inert until this query's answer comes.
    expect(screen.getByRole('list', { name: /^Results for/ })).toHaveAttribute('inert')
    await userEvent.type(field(), '{Enter}')
    expect(screen.getByRole('heading', { level: 1, name: 'Search' })).toBeInTheDocument()
  })

  it('never shows one search’s results under an unrelated one', async () => {
    const { services, api } = fakeServices()
    renderWithApp(<AppRoutes />, '/search?q=blue%20hour', services)
    await results()
    api.search.library.mockReturnValue(new Promise<never>(() => {}))
    api.search.catalog.mockReturnValue(new Promise<never>(() => {}))
    await userEvent.clear(field())
    await userEvent.type(field(), 'amber')
    await waitFor(() => expect(api.search.library).toHaveBeenLastCalledWith({ q: 'amber', limit: 20, scope: 'server' }, expect.anything()))
    expect(screen.queryByRole('list', { name: /^Results for/ })).toBeNull()
    expect(screen.getByRole('status', { name: 'Searching' })).toBeInTheDocument()
  })

  it('keeps rows where they were when the same search is answered again', async () => {
    const { services, api } = fakeServices()
    const { queryClient } = renderWithApp(<AppRoutes />, '/search?q=mira%20vale', services)
    await results()
    await waitFor(() => expect(screen.queryByText('Searching for more…')).toBeNull())
    const before = rows()
    // The server ranks the songs the other way round now (a play moved one up).
    const reversed = (answer: SearchResults) => ({ ...answer, ranked: answer.ranked?.map((entry, index, all) => ({ ...entry, score: all[all.length - 1 - index]!.score })) })
    api.search.library.mockImplementation(async (params: Params) => reversed(searchPage(searchFixtures(params.q).library, params)))
    api.search.catalog.mockImplementation(async (params: Params) => reversed(searchPage(searchFixtures(params.q).catalog, params)))
    await act(() => queryClient.invalidateQueries({ queryKey: ['search'] }))
    await waitFor(() => expect(api.search.library).toHaveBeenCalledTimes(2))
    expect(rows()).toEqual(before)
  })

  it('wraps a long query in the no-results message rather than widening the page', async () => {
    const long = 'a'.repeat(110)
    renderWithApp(<AppRoutes />, `/search?q=${long}`)
    const title = await screen.findByRole('heading', { name: `No results for “${long}”` })
    expect(title).toHaveClass('[overflow-wrap:anywhere]', 'max-w-full')
  })

  it('says a single letter is too short to search', async () => {
    renderWithApp(<AppRoutes />, '/search?q=a')
    expect(await screen.findByText(/Keep typing/)).toBeInTheDocument()
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
    expect(await screen.findByText('Couldn’t search the catalog', {}, { timeout: 4000 })).toBeInTheDocument()
    expect(screen.getByText('Only music on this server is listed.')).toBeInTheDocument()
    expect(rows()[0]).toBe('Mira Vale — Artist')
    api.search.catalog.mockImplementation(async (params: Params) => searchPage(searchFixtures(params.q).catalog, params))
    await userEvent.click(within(screen.getByRole('alert')).getByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(screen.queryByText('Couldn’t search the catalog')).toBeNull())
  })

  it.each([['all', ''], ['a filter', '&type=artist']])('says the catalog could not be searched, not "No results", when the server has nothing either, in %s', async (_where, filter) => {
    const { services, api } = fakeServices()
    api.search.catalog.mockRejectedValue(new ApiError(503, 'provider_unavailable', 'Down'))
    renderWithApp(<AppRoutes />, `/search?q=pale%20meridian${filter}`, services)
    expect(await screen.findByText('Couldn’t search the catalog', {}, { timeout: 4000 })).toBeInTheDocument()
    expect(screen.getByText('Nothing on this server matches “pale meridian”.')).toBeInTheDocument()
    expect(screen.queryByText(/^No (results|artists) for/)).toBeNull()
    expect(within(screen.getByRole('alert')).getByRole('button', { name: 'Try again' })).toBeInTheDocument()
  })

  it('ends a filter’s list with the failure and Try again when its next page fails, instead of asking again and again', async () => {
    const { services, api } = fakeServices()
    const many = Array.from({ length: 30 }, (_, n) => ({ ...track('amber'), id: `00000000-0000-4000-8f00-${String(n).padStart(12, '0')}`, title: `Blue ${n}` }))
    const down = new ApiError(503, 'unavailable', 'The server is busy.')
    api.search.library.mockImplementation(async (params: Params) => {
      if (params.offset) throw down
      return { artists: [], albums: [], tracks: many, provider: null } satisfies SearchResults
    })
    api.search.catalog.mockImplementation(async (params: Params) => {
      if (params.offset) throw down
      return searchPage(searchFixtures(params.q).catalog, params)
    })
    renderWithApp(<AppRoutes />, '/search?q=blue&type=track', services)
    await waitFor(() => expect(rows().length).toBeGreaterThan(29))
    await userEvent.click(await screen.findByRole('button', { name: 'Show more' }))
    const failure = await screen.findByRole('alert', {}, { timeout: 4000 })
    expect(within(failure).getByText('More results didn’t load')).toBeInTheDocument()
    expect(within(failure).getByText('The server is busy.')).toBeInTheDocument()
    const asked = api.search.library.mock.calls.length
    // The rows already found stay, and nothing asks for the page again on its own.
    await new Promise(resolve => setTimeout(resolve, 1500))
    expect(api.search.library.mock.calls.length).toBe(asked)
    expect(rows().length).toBeGreaterThan(29)
    expect(screen.queryByText('Searching for more…')).toBeNull()
    await userEvent.click(within(failure).getByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(api.search.library.mock.calls.length).toBeGreaterThan(asked))
  }, 15_000)

  it('never lets a filter’s results for an unrelated search stand in, and never opens faded ones', async () => {
    const { services, api } = fakeServices()
    renderWithApp(<><AppRoutes /><Where /></>, '/search?q=mira%20vale&type=artist', services)
    await results()
    await waitFor(() => expect(rows()).toContain('Mira Vale — Artist'))
    api.search.library.mockReturnValue(new Promise<never>(() => {}))
    api.search.catalog.mockReturnValue(new Promise<never>(() => {}))
    // Typed on: the same search, so its rows stay, faded and inert.
    await userEvent.type(field(), ' x')
    expect(screen.getByRole('list', { name: /^Results for/ })).toHaveAttribute('inert')
    // Something else: none of the earlier rows show.
    await userEvent.clear(field())
    await userEvent.type(field(), 'lune park')
    await waitFor(() => expect(api.search.library).toHaveBeenLastCalledWith(expect.objectContaining({ q: 'lune park', type: 'artist' }), expect.anything()))
    expect(screen.queryByRole('link', { name: 'Mira Vale, Artist' })).toBeNull()
    expect(screen.getByTestId('where').textContent).toMatch(/^\/search/)
  })

  it('says what the page is for when there is nothing searched and no genre to browse', async () => {
    const { services, api } = fakeServices()
    api.catalog.genres.mockResolvedValue({ items: [], nextCursor: null })
    renderWithApp(<AppRoutes />, '/search', services)
    expect(await screen.findByRole('heading', { level: 2, name: 'Search your music' })).toBeInTheDocument()
    expect(screen.getByText('Find songs, albums, artists and playlists by name.')).toBeInTheDocument()
  })

  it('leaves the guidance out while genres load, and once there are genres to browse', async () => {
    renderWithApp(<AppRoutes />, '/search')
    expect(screen.queryByRole('heading', { name: 'Search your music' })).toBeNull()
    expect(await screen.findByRole('heading', { name: 'Browse by genre' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Search your music' })).toBeNull()
  })

  it('records an opened result without saving its query', async () => {
    renderWithApp(<><AppRoutes /><Where /></>, '/search?q=mira%20vale')
    await results()
    await userEvent.click(await screen.findByRole('link', { name: 'Mira Vale, Artist' }))
    await screen.findByRole('heading', { level: 1, name: 'Mira Vale' })
    expect(JSON.parse(localStorage.getItem(recentKey)!)).toEqual([{ type: 'artist', artist: { ...artists[0], liked: false } }])
  })

  it('shows and clears recently viewed results while ignoring older query history', async () => {
    localStorage.setItem(recentKey, JSON.stringify([{ type: 'query', query: 'obsolete text query' }, ...artists.slice(0, 2).map(artist => ({ type: 'artist', artist }))]))
    renderWithApp(<AppRoutes />, '/search')
    const recent = await screen.findByRole('list', { name: 'Recently viewed' })
    expect(within(recent).getAllByRole('listitem')).toHaveLength(2)
    expect(screen.queryByText('obsolete text query')).not.toBeInTheDocument()
    expect(screen.queryByText('Recent searches')).not.toBeInTheDocument()
    await userEvent.click(within(recent).getByRole('button', { name: `Remove ${artists[0]!.name} from recently viewed` }))
    expect(within(recent).getAllByRole('listitem')).toHaveLength(1)
    await userEvent.click(screen.getByRole('button', { name: 'Clear all recently viewed' }))
    expect(screen.queryByRole('list', { name: 'Recently viewed' })).not.toBeInTheDocument()
    expect(localStorage.getItem(recentKey)).toBeNull()
  })
})
