import { ApiError } from '@squirmy/client-core'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useLocation } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AppRoutes } from '@/App'
import { albumDetail, libraryAlbums, libraryArtists, libraryTracks, playlistSummaries, searchFixtures } from '@/fixtures/catalog'
import { currentUser } from '@/fixtures/server'
import { fakeServices } from '@/test/fake-services'
import { renderWithApp } from '@/test/render'

function Where() {
  const location = useLocation()
  return <output data-testid="where">{location.pathname + location.search}</output>
}
const where = () => new URL(screen.getByTestId('where').textContent!, 'http://squirmy.test')

/** The app at `route`, once the shell is up. */
async function renderLibrary(route: string, fake = fakeServices()) {
  renderWithApp(<><AppRoutes /><Where /></>, route, fake.services)
  await screen.findByRole('main', { hidden: true })
  return fake
}

const main = () => within(screen.getByRole('main'))
const filters = () => within(screen.getByRole('navigation', { name: 'Library filters' }))
const chosenFilter = () => filters().getAllByRole('link').filter(link => link.getAttribute('aria-current') === 'page').map(link => link.textContent)
/** The title of each tile or row, in order. */
const titles = (list: HTMLElement) => within(list).getAllByRole('listitem').map(item => within(item).getAllByRole('link')[0]!.textContent)
/** The same for rows, whose link also holds the subtitle. */
const rowTitles = (list: HTMLElement) => within(list).getAllByRole('listitem').map(item => within(item).getAllByRole('link')[0]!.getAttribute('title')!)

beforeEach(() => {
  localStorage.clear()
  // jsdom lays nothing out, so the virtual lists would show no rows: every box is a screen's size.
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1024)
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(900)
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(220)
})
afterEach(() => {
  vi.restoreAllMocks()
})

/**
 * A failure the client does not retry, so the page shows it at once. A 503 ends the same way,
 * after the query's retries, which would only make these tests slower.
 */
const refused = (message: string) => new ApiError(400, 'invalid_request', message)
const search = () => screen.getByRole('searchbox', { name: 'Find in your library' })
const ownPlaylists = { items: playlistSummaries.map(playlist => ({ ...playlist, ownerId: currentUser.id })), nextCursor: null }

describe('Library', () => {
  it('has one set of filter chips, as on iOS, and no genre menu', async () => {
    await renderLibrary('/library?filter=all')
    await main().findByRole('list', { name: 'Library' })
    expect(filters().getAllByRole('link').map(link => link.textContent)).toEqual(['All', 'Playlists', 'Albums', 'Artists', 'Songs'])
    expect(chosenFilter()).toEqual(['All'])
    expect(screen.queryByRole('combobox', { name: 'Genre' })).toBeNull()
  })

  it('shows every chip on a phone, wrapping under the header rather than scrolling out of sight', async () => {
    vi.stubGlobal('matchMedia', (media: string) => ({
      media, matches: media === '(width < 768px)', addEventListener() {}, removeEventListener() {},
    }))
    try {
      await renderLibrary('/library?filter=all')
      await main().findByRole('list', { name: 'Library' })
      const nav = screen.getByRole('navigation', { name: 'Library filters' })
      expect(nav.closest('header')).toBeNull()
      expect(nav).toHaveClass('flex-wrap')
      expect(filters().getAllByRole('link').map(link => link.textContent)).toEqual(['All', 'Playlists', 'Albums', 'Artists', 'Songs'])
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('lists Liked Songs, the playlists, the albums and the artists in one grid under All, in the server’s order', async () => {
    const fake = fakeServices()
    const [first, second] = libraryAlbums
    const artist = libraryArtists[0]!
    // Recently played: an artist and an album before Liked Songs.
    fake.api.catalog.items.mockResolvedValue({ nextCursor: null, items: [
      { kind: 'artist', artist, playedAt: '2026-11-20T10:00:00.000Z' },
      { kind: 'album', album: second!, playedAt: '2026-11-19T10:00:00.000Z' },
      { kind: 'liked', playedAt: null },
      { kind: 'playlist', playlist: ownPlaylists.items[0]!, playedAt: null },
      { kind: 'album', album: first!, playedAt: null },
    ] })
    await renderLibrary('/library?filter=all', fake)
    const list = await main().findByRole('list', { name: 'Library' })
    await waitFor(() => expect(titles(list)).toEqual([artist.name, second!.title, 'Liked Songs', ownPlaylists.items[0]!.name, first!.title]))
    // No Artists section: the artist is a tile among the rest.
    expect(main().queryByRole('heading', { name: 'Artists' })).toBeNull()
    expect(fake.api.catalog.items).toHaveBeenLastCalledWith(expect.objectContaining({ sort: 'played' }))
    expect(fake.api.catalog.albums).not.toHaveBeenCalled()
  })

  describe('old addresses', () => {
    it.each([
      ['/library/albums', 'albums', 'Albums'],
      ['/library/artists', 'artists', 'Artists'],
      ['/library/songs', 'songs', 'Songs'],
      ['/library/playlists', 'playlists', 'Playlists'],
    ])('%s lands on the combined view with its filter chosen', async (route, filter, chip) => {
      await renderLibrary(route)
      await waitFor(() => expect(where().pathname).toBe('/library'))
      expect(where().searchParams.get('filter')).toBe(filter)
      expect(await screen.findByRole('heading', { level: 1, name: 'Library' })).toBeInTheDocument()
      expect(chosenFilter()).toEqual([chip])
    })

    it('keeps the sort and genre an old address carried', async () => {
      await renderLibrary('/library/albums?sort=title&genre=Dream%20Pop')
      await waitFor(() => expect(where().searchParams.get('filter')).toBe('albums'))
      expect(where().searchParams.get('sort')).toBe('title')
      expect(await screen.findByText('Dream Pop')).toBeInTheDocument()
    })

    it('keeps the genre between Albums and Songs, and lists the songs in it', async () => {
      const { api } = await renderLibrary('/library?filter=albums&genre=Dream%20Pop')
      await main().findByRole('list', { name: 'Albums' })
      expect(filters().getByRole('link', { name: 'Songs' })).toHaveAttribute('href', '/library?filter=songs&genre=Dream+Pop')
      expect(filters().getByRole('link', { name: 'All' })).toHaveAttribute('href', '/library?filter=all&genre=Dream+Pop')
      // Playlists and artists take no genre: a chip there would change nothing.
      expect(filters().getByRole('link', { name: 'Playlists' })).toHaveAttribute('href', '/library?filter=playlists')
      expect(filters().getByRole('link', { name: 'Artists' })).toHaveAttribute('href', '/library?filter=artists')

      await userEvent.click(filters().getByRole('link', { name: 'Songs' }))
      await main().findByRole('list', { name: 'Songs' })
      expect(where().searchParams.get('genre')).toBe('Dream Pop')
      expect(api.catalog.tracks).toHaveBeenLastCalledWith(expect.objectContaining({ genre: 'Dream Pop' }))
      expect(screen.getByRole('button', { name: 'Show every genre' })).toBeInTheDocument()
    })

    it('keeps Liked Songs on its own page', async () => {
      await renderLibrary('/liked')
      expect(await screen.findByRole('heading', { level: 1, name: 'Liked Songs' })).toBeInTheDocument()
      expect(where().pathname).toBe('/liked')
    })
  })

  describe('the filter', () => {
    it('opens /library on the filter this browser chose last', async () => {
      await renderLibrary('/library?filter=all')
      await main().findByRole('list', { name: 'Library' })
      await userEvent.click(filters().getByRole('link', { name: 'Artists' }))
      expect(await main().findByRole('list', { name: 'Artists' })).toBeInTheDocument()
      expect(localStorage.getItem('squirmy.library.filter')).toBe('artists')
    })

    it('restores the saved filter on /library', async () => {
      localStorage.setItem('squirmy.library.filter', 'songs')
      await renderLibrary('/library')
      await waitFor(() => expect(where().searchParams.get('filter')).toBe('songs'))
      expect(await main().findByRole('list', { name: 'Songs' })).toBeInTheDocument()
    })

    it('opens on All when the browser keeps nothing, or refuses storage', async () => {
      vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied') })
      vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('denied') })
      await renderLibrary('/library')
      await waitFor(() => expect(where().searchParams.get('filter')).toBe('all'))
      expect(await main().findByRole('list', { name: 'Library' })).toBeInTheDocument()
      await userEvent.click(screen.getByRole('button', { name: 'Show list view' }))
      expect(screen.getByRole('button', { name: 'Show grid view' })).toBeInTheDocument()
    })

    it('loads only the lists the filter shows', async () => {
      const { api } = await renderLibrary('/library?filter=playlists')
      const list = await main().findByRole('list', { name: 'Playlists' })
      expect(titles(list)).toEqual(['Liked Songs', ...playlistSummaries.map(playlist => playlist.name)])
      expect(api.catalog.albums).not.toHaveBeenCalled()
      expect(api.catalog.artists).not.toHaveBeenCalled()
      expect(api.catalog.tracks).not.toHaveBeenCalled()
    })

    it('counts Liked Songs among the playlists, as it is listed and labeled', async () => {
      await renderLibrary('/library?filter=playlists')
      await main().findByRole('list', { name: 'Playlists' })
      expect(await screen.findByText(`${playlistSummaries.length + 1} playlists`)).toBeInTheDocument()
    })

    it('lists songs as songs, with no grid', async () => {
      await renderLibrary('/library?filter=songs')
      const list = await main().findByRole('list', { name: 'Songs' })
      expect(within(list).getAllByRole('listitem').length).toBeGreaterThan(0)
      expect(within(list).getByText(libraryTracks[0]!.title)).toBeInTheDocument()
      expect(screen.queryByRole('button', { name: /Show (list|grid) view/ })).toBeNull()
    })
  })

  describe('sort', () => {
    const sortOptions = async () => {
      await userEvent.click(screen.getByRole('combobox', { name: 'Sort by' }))
      const options = (await screen.findAllByRole('option')).map(option => option.textContent)
      await userEvent.keyboard('{Escape}')
      return options
    }

    it('offers every order for albums and no year for songs', async () => {
      await renderLibrary('/library?filter=albums')
      await main().findByRole('list', { name: 'Albums' })
      expect(await sortOptions()).toEqual(['Recently added', 'Title', 'Artist', 'Year'])
      await userEvent.click(filters().getByRole('link', { name: 'Songs' }))
      await main().findByRole('list', { name: 'Songs' })
      expect(await sortOptions()).toEqual(['Recently added', 'Title', 'Artist'])
    })

    it.each(['artists', 'playlists'])('has no sort for %s', async filter => {
      await renderLibrary(`/library?filter=${filter}`)
      await main().findByRole('list', { name: filter === 'artists' ? 'Artists' : 'Playlists' })
      expect(screen.queryByRole('combobox', { name: 'Sort by' })).toBeNull()
    })

    // Two tests, each waiting on one state: choosing an order changes the address, and the
    // address is what the list asks the server for. Checked in one go, the request after a
    // choice in the menu depended on when React ran the list's effects, and failed under load.
    it('keeps the order chosen in the address and across the chips', async () => {
      await renderLibrary('/library?filter=albums')
      await main().findByRole('list', { name: 'Albums' })
      await userEvent.click(screen.getByRole('combobox', { name: 'Sort by' }))
      await userEvent.click(await screen.findByRole('option', { name: 'Title' }))
      await waitFor(() => expect(where().searchParams.get('sort')).toBe('title'))
      expect(filters().getByRole('link', { name: 'Songs' })).toHaveAttribute('href', '/library?filter=songs&sort=title')
    })

    it('asks the server for the order in the address', async () => {
      const { api } = await renderLibrary('/library?filter=albums&sort=title')
      await main().findByRole('list', { name: 'Albums' })
      expect(api.catalog.albums).toHaveBeenCalledTimes(1)
      expect(api.catalog.albums).toHaveBeenLastCalledWith(expect.objectContaining({ sort: 'title' }))
      expect(screen.getByRole('combobox', { name: 'Sort by' })).toHaveTextContent('Title')
    })

    it('opens All in recently played, and offers every other order too', async () => {
      await renderLibrary('/library?filter=all')
      await main().findByRole('list', { name: 'Library' })
      expect(screen.getByRole('combobox', { name: 'Sort by' })).toHaveTextContent('Sort:Recently played')
      expect(await sortOptions()).toEqual(['Recently played', 'Recently added', 'Title', 'Artist', 'Year'])
      expect(where().searchParams.get('sort')).toBeNull()
    })

    it('keeps recently added in the address under All, where it is not the default', async () => {
      await renderLibrary('/library?filter=all')
      await main().findByRole('list', { name: 'Library' })
      await userEvent.click(screen.getByRole('combobox', { name: 'Sort by' }))
      await userEvent.click(await screen.findByRole('option', { name: 'Recently added' }))
      await waitFor(() => expect(where().searchParams.get('sort')).toBe('recent'))
      // Albums open in recently added anyway, so the chip carries no sort.
      expect(filters().getByRole('link', { name: 'Albums' })).toHaveAttribute('href', '/library?filter=albums')
    })

    it('asks the server for All in the order in the address', async () => {
      const { api } = await renderLibrary('/library?filter=all&sort=title')
      await main().findByRole('list', { name: 'Library' })
      expect(api.catalog.items).toHaveBeenLastCalledWith(expect.objectContaining({ sort: 'title' }))
      expect(screen.getByRole('combobox', { name: 'Sort by' })).toHaveTextContent('Title')
    })

    it('falls back to Recently added where the order chosen does not apply', async () => {
      const { api } = await renderLibrary('/library?filter=songs&sort=year')
      await main().findByRole('list', { name: 'Songs' })
      expect(api.catalog.tracks).toHaveBeenLastCalledWith(expect.objectContaining({ sort: 'recent' }))
      expect(screen.getByRole('combobox', { name: 'Sort by' })).toHaveTextContent('Recently added')
    })
  })

  describe('grid and list', () => {
    it('switches to rows and remembers it in this browser', async () => {
      await renderLibrary('/library?filter=albums')
      const grid = await main().findByRole('list', { name: 'Albums' })
      expect(within(grid).getAllByRole('button', { name: /^Play / }).length).toBeGreaterThan(0)
      await userEvent.click(screen.getByRole('button', { name: 'Show list view' }))
      const list = main().getByRole('list', { name: 'Albums' })
      // Every row the virtual list shows plays from its own button.
      expect(within(list).getAllByRole('button', { name: /^Play / }).map(button => button.getAttribute('aria-label'))).toEqual(rowTitles(list).map(title => `Play ${title}`))
      expect(within(list).getAllByRole('link')[0]).toHaveTextContent(`${libraryAlbums[0]!.title}Album · ${libraryAlbums[0]!.artistCredit}`)
      expect(localStorage.getItem('squirmy.library.layout')).toBe('list')
    })

    it('keeps one-click play on every row that plays, from the pointer or the keyboard', async () => {
      localStorage.setItem('squirmy.library.layout', 'list')
      const fake = await renderLibrary('/library?filter=all')
      const list = await main().findByRole('list', { name: 'Library' })
      await waitFor(() => expect(rowTitles(list)).toContain('Blue Hour'))
      // An empty playlist has nothing to play, on a row as on a card.
      const empty = playlistSummaries.filter(playlist => !playlist.trackCount).map(playlist => playlist.name)
      const playing = within(list).getAllByRole('button', { name: /^Play / }).map(button => button.getAttribute('aria-label'))
      expect(playing).toEqual(rowTitles(list).filter(title => !empty.includes(title)).map(title => `Play ${title}`))
      expect(playing).toContain('Play Liked Songs')
      // The button is a stop of its own before the row's link, as on a card.
      const blueHour = within(list).getByRole('button', { name: 'Play Blue Hour' })
      blueHour.focus()
      await userEvent.keyboard('{Enter}')
      await waitFor(() => expect(fake.socket.session.current?.trackId).toBe(albumDetail(libraryAlbums[0]!.id)!.discs[0]!.tracks[0]!.id))
    })

    it('gives album rows the card’s menu', async () => {
      localStorage.setItem('squirmy.library.layout', 'list')
      await renderLibrary('/library?filter=albums')
      const list = await main().findByRole('list', { name: 'Albums' })
      await userEvent.click(within(list).getByRole('button', { name: 'More options for Glass City' }))
      expect(await screen.findByRole('menuitem', { name: 'Save to library' })).toBeEnabled()
      expect(screen.getByRole('menuitem', { name: 'Go to North Index' })).toBeInTheDocument()
    })

    it('opens in the layout chosen last', async () => {
      localStorage.setItem('squirmy.library.layout', 'list')
      await renderLibrary('/library?filter=artists')
      await main().findByRole('list', { name: 'Artists' })
      expect(screen.getByRole('button', { name: 'Show grid view' })).toBeInTheDocument()
    })
  })

  describe('search', () => {
    it('filters what is loaded on one character, without asking the server', async () => {
      const { api } = await renderLibrary('/library?filter=artists')
      await main().findByRole('list', { name: 'Artists' })
      await userEvent.type(screen.getByRole('searchbox', { name: 'Find in your library' }), 'm')
      const list = main().getByRole('list', { name: 'Artists' })
      expect(titles(list)).toEqual(libraryArtists.filter(artist => artist.name.toLowerCase().includes('m')).map(artist => artist.name))
      expect(api.search.library).not.toHaveBeenCalled()
    })

    it('searches the whole library on the server from two characters', async () => {
      const { api } = await renderLibrary('/library?filter=albums')
      await main().findByRole('list', { name: 'Albums' })
      await userEvent.type(screen.getByRole('searchbox', { name: 'Find in your library' }), 'blue')
      await waitFor(() => expect(api.search.library).toHaveBeenLastCalledWith({ q: 'blue', limit: 50 }, expect.anything()))
      await waitFor(() => expect(titles(main().getByRole('list', { name: 'Albums' }))).toEqual(['Blue Hour']))
      // Matches come best first, whatever the sort.
      expect(screen.queryByRole('combobox', { name: 'Sort by' })).toBeNull()
    })

    it('keeps a search to the genre chosen', async () => {
      const { api } = await renderLibrary('/library?filter=albums&genre=Dream%20Pop')
      await main().findByRole('list', { name: 'Albums' })
      await userEvent.type(search(), 'blue')
      await waitFor(() => expect(api.search.library).toHaveBeenLastCalledWith({ q: 'blue', limit: 50, genre: 'Dream Pop' }, expect.anything()))
      expect(screen.getByText('Dream Pop')).toBeInTheDocument()
    })

    it('lists the songs a search matches under All, so a song is never “Nothing found”', async () => {
      const fake = await renderLibrary('/library?filter=all')
      await main().findByRole('list', { name: 'Library' })
      await userEvent.type(search(), 'riverside')
      const songs = await screen.findByRole('region', { name: 'Songs' })
      expect(within(songs).getByText('Riverside')).toBeInTheDocument()
      expect(screen.queryByRole('heading', { name: 'Nothing found' })).toBeNull()
      // No collection matched, so there is no grid above the songs.
      expect(main().queryByRole('list', { name: 'Library' })).toBeNull()
      await userEvent.click(within(songs).getByRole('button', { name: 'Play Riverside' }))
      const riverside = libraryTracks.find(track => track.title === 'Riverside')!
      await waitFor(() => expect(fake.socket.session.current?.trackId).toBe(riverside.id))
    })

    it('lists matching songs after the collections under All', async () => {
      await renderLibrary('/library?filter=all')
      await main().findByRole('list', { name: 'Library' })
      await userEvent.type(search(), 'blue')
      const songs = await screen.findByRole('region', { name: 'Songs' })
      expect(within(songs).getByText('Blue in the Dark')).toBeInTheDocument()
      expect(titles(main().getByRole('list', { name: 'Library' }))).toEqual(['Blue Hour'])
    })

    it('says when nothing matches', async () => {
      await renderLibrary('/library?filter=all')
      await main().findByRole('list', { name: 'Library' })
      await userEvent.type(screen.getByRole('searchbox', { name: 'Find in your library' }), 'zzzz')
      expect(await screen.findByRole('heading', { name: 'Nothing found' })).toBeInTheDocument()
      await userEvent.click(screen.getByRole('button', { name: 'Clear search' }))
      expect(await main().findByRole('list', { name: 'Library' })).toBeInTheDocument()
    })

    it('only filters playlists here, never searching the server', async () => {
      const { api } = await renderLibrary('/library?filter=playlists')
      await main().findByRole('list', { name: 'Playlists' })
      await userEvent.type(screen.getByRole('searchbox', { name: 'Find in your library' }), 'liked')
      expect(titles(main().getByRole('list', { name: 'Playlists' }))).toEqual(['Liked Songs'])
      expect(api.search.library).not.toHaveBeenCalled()
    })
  })

  describe('album cards', () => {
    it('offer the album page’s menu from ⋯ and from a right-click', async () => {
      await renderLibrary('/library?filter=albums')
      const grid = await main().findByRole('list', { name: 'Albums' })
      await userEvent.click(within(grid).getByRole('button', { name: 'More options for Blue Hour' }))
      // The one library entry waits for the album, which says it is saved.
      expect(await screen.findByRole('menuitem', { name: 'Remove from library' })).toBeEnabled()
      expect(screen.getAllByRole('menuitem').map(item => item.textContent)).toEqual(['Play', 'Play next', 'Add to queue', 'Add to playlist', 'Remove from library', 'Go to Mira Vale'])
      await userEvent.keyboard('{Escape}')
      await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())

      fireEvent.contextMenu(within(grid).getByRole('link', { name: 'Glass City' }))
      expect(await screen.findByRole('menuitem', { name: 'Save to library' })).toBeEnabled()
      expect(screen.getAllByRole('menuitem').map(item => item.textContent)).toEqual(['Play', 'Play next', 'Add to queue', 'Add to playlist', 'Save to library', 'Go to North Index'])
    })

    it('queue an album and save it from the menu', async () => {
      const fake = await renderLibrary('/library?filter=albums')
      const grid = await main().findByRole('list', { name: 'Albums' })
      await userEvent.click(within(grid).getByRole('button', { name: 'More options for Glass City' }))
      await userEvent.click(await screen.findByRole('menuitem', { name: 'Add to queue' }))
      // The entry says it worked, the queue being out of sight, then the menu closes.
      expect(await screen.findByRole('menuitem', { name: 'Added to queue' })).toBeInTheDocument()
      await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
      const glassCity = albumDetail(libraryAlbums[2]!.id)!
      await waitFor(() => expect(fake.socket.session.queue.map(entry => entry.trackId)).toEqual(glassCity.discs.flatMap(disc => disc.tracks).map(track => track.id)))

      await userEvent.click(within(grid).getByRole('button', { name: 'More options for Glass City' }))
      await userEvent.click(await screen.findByRole('menuitem', { name: 'Save to library' }))
      expect(fake.api.userdata.like).toHaveBeenCalledWith('album', glassCity.id)
      expect(await screen.findByRole('menuitem', { name: 'Saved to library' })).toBeInTheDocument()
    })
  })

  describe('when a request fails', () => {
    it('keeps Liked Songs under Playlists, says the playlists failed, and asks again', async () => {
      const fake = fakeServices()
      fake.api.userdata.playlists.mockRejectedValue(refused('Playlists are resting'))
      await renderLibrary('/library?filter=playlists', fake)
      expect(await screen.findByText('Your playlists didn’t load.')).toBeInTheDocument()
      expect(titles(main().getByRole('list', { name: 'Playlists' }))).toEqual(['Liked Songs'])
      expect(screen.getByText('Playlists are resting')).toBeInTheDocument()

      fake.api.userdata.playlists.mockResolvedValue(ownPlaylists)
      await userEvent.click(screen.getByRole('button', { name: 'Try again' }))
      await waitFor(() => expect(titles(main().getByRole('list', { name: 'Playlists' }))).toEqual(['Liked Songs', ...playlistSummaries.map(playlist => playlist.name)]))
      expect(screen.queryByText('Your playlists didn’t load.')).toBeNull()
    })

    it('keeps the chips and the toolbar under All when it fails, and asks again', async () => {
      const fake = fakeServices()
      fake.api.catalog.items.mockRejectedValue(refused('The library is resting'))
      await renderLibrary('/library?filter=all', fake)
      const failed = await screen.findByRole('alert')
      expect(failed).toHaveTextContent('Your library didn’t load')
      expect(failed).toHaveTextContent('The library is resting')
      expect(filters().getAllByRole('link')).toHaveLength(5)
      expect(screen.queryByRole('heading', { name: 'This page did not load' })).toBeNull()

      fake.api.catalog.items.mockResolvedValue({ items: [{ kind: 'liked', playedAt: null }, ...libraryAlbums.map(album => ({ kind: 'album' as const, album, playedAt: null }))], nextCursor: null })
      await userEvent.click(within(failed).getByRole('button', { name: 'Try again' }))
      await waitFor(() => expect(titles(main().getByRole('list', { name: 'Library' }))).toEqual(['Liked Songs', ...libraryAlbums.map(album => album.title)]))
      expect(screen.queryByText('Your library didn’t load')).toBeNull()
    })

    it.each([
      ['albums', 'albums'],
      ['songs', 'songs'],
      ['artists', 'artists'],
    ] as const)('keeps the chips and the toolbar when the %s fail', async (filter, what) => {
      const fake = fakeServices()
      const call = { albums: fake.api.catalog.albums, songs: fake.api.catalog.tracks, artists: fake.api.catalog.artists }[filter]
      call.mockRejectedValue(refused('Resting'))
      await renderLibrary(`/library?filter=${filter}`, fake)
      expect(await screen.findByRole('alert')).toHaveTextContent(`Your ${what} didn’t load`)
      expect(chosenFilter()).toEqual([filter[0]!.toUpperCase() + filter.slice(1)])
      expect(search()).toBeInTheDocument()
    })

    it('lists All whole when only the playlists’ own list fails, the server listing them there', async () => {
      const fake = fakeServices()
      fake.api.userdata.playlists.mockRejectedValue(refused('Playlists are resting'))
      await renderLibrary('/library?filter=all', fake)
      await waitFor(() => expect(titles(main().getByRole('list', { name: 'Library' }))).toContain(playlistSummaries[0]!.name))
      expect(screen.queryByText('Your playlists didn’t load.')).toBeNull()
    })

    it('says a failed search failed, even with the list loaded, and asks again', async () => {
      const fake = await renderLibrary('/library?filter=albums')
      await main().findByRole('list', { name: 'Albums' })
      fake.api.search.library.mockRejectedValue(refused('Search is resting'))
      await userEvent.type(search(), 'blue')
      expect(await screen.findByRole('heading', { name: 'Couldn’t search your library' })).toBeInTheDocument()
      expect(screen.getByText('Search is resting')).toBeInTheDocument()

      fake.api.search.library.mockImplementation(async ({ q }) => searchFixtures(q).library)
      await userEvent.click(screen.getByRole('button', { name: 'Try again' }))
      await waitFor(() => expect(titles(main().getByRole('list', { name: 'Albums' }))).toEqual(['Blue Hour']))
      expect(screen.queryByRole('heading', { name: 'Couldn’t search your library' })).toBeNull()
    })

    it('comes back to the list when the failed search is cleared', async () => {
      const fake = await renderLibrary('/library?filter=albums')
      await main().findByRole('list', { name: 'Albums' })
      fake.api.search.library.mockRejectedValue(refused('Search is resting'))
      await userEvent.type(search(), 'blue')
      expect(await screen.findByRole('heading', { name: 'Couldn’t search your library' })).toBeInTheDocument()
      await userEvent.click(screen.getByRole('button', { name: 'Clear search' }))
      expect(titles(await main().findByRole('list', { name: 'Albums' }))).toEqual(libraryAlbums.map(album => album.title))
      expect(screen.queryByRole('heading', { name: 'Couldn’t search your library' })).toBeNull()
    })
  })

  describe('empty', () => {
    it('says the heart is how music gets in', async () => {
      const fake = fakeServices()
      fake.api.catalog.albums.mockResolvedValue({ items: [], nextCursor: null })
      await renderLibrary('/library?filter=albums', fake)
      expect(await screen.findByRole('heading', { name: 'Add music to your library' })).toBeInTheDocument()
      expect(screen.getByText(/tap the heart\.$/)).toBeInTheDocument()
      expect(document.body.textContent).not.toMatch(/Add to library/)
    })

    it('still shows Liked Songs under All', async () => {
      const fake = fakeServices()
      fake.api.catalog.items.mockResolvedValue({ items: [{ kind: 'liked', playedAt: null }], nextCursor: null })
      await renderLibrary('/library?filter=all', fake)
      const list = await main().findByRole('list', { name: 'Library' })
      expect(titles(list)[0]).toBe('Liked Songs')
      expect(screen.getByRole('heading', { name: 'Add music to your library' })).toBeInTheDocument()
    })

    it('offers every genre again when a genre matched nothing', async () => {
      const fake = fakeServices()
      fake.api.catalog.albums.mockResolvedValue({ items: [], nextCursor: null })
      await renderLibrary('/library?filter=albums&genre=Polka', fake)
      expect(await screen.findByRole('heading', { name: 'Nothing tagged “Polka”' })).toBeInTheDocument()
      await userEvent.click(screen.getAllByRole('button', { name: 'Show every genre' })[0]!)
      await waitFor(() => expect(where().searchParams.get('genre')).toBeNull())
    })
  })
})
