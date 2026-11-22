import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useLocation } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AppRoutes } from '@/App'
import { libraryAlbums, libraryArtists, libraryTracks, playlistSummaries } from '@/fixtures/catalog'
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

beforeEach(() => {
  localStorage.clear()
  // jsdom lays nothing out, so the virtual lists would show no rows: every box is a screen's size.
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1024)
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(900)
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(220)
})
afterEach(() => vi.restoreAllMocks())

describe('Library', () => {
  it('has one set of filter chips, as on iOS, and no genre menu', async () => {
    await renderLibrary('/library?filter=all')
    await main().findByRole('list', { name: 'Library' })
    expect(filters().getAllByRole('link').map(link => link.textContent)).toEqual(['All', 'Playlists', 'Albums', 'Artists', 'Songs'])
    expect(chosenFilter()).toEqual(['All'])
    expect(screen.queryByRole('combobox', { name: 'Genre' })).toBeNull()
  })

  it('lists Liked Songs first, then the playlists, then the albums under All', async () => {
    await renderLibrary('/library?filter=all')
    const list = await main().findByRole('list', { name: 'Library' })
    await waitFor(() => expect(titles(list)).toHaveLength(1 + playlistSummaries.length + libraryAlbums.length))
    expect(titles(list)).toEqual(['Liked Songs', ...playlistSummaries.map(playlist => playlist.name), ...libraryAlbums.map(album => album.title)])
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
      expect(within(list).queryAllByRole('button', { name: /^Play / })).toHaveLength(0)
      expect(within(list).getAllByRole('link')[0]).toHaveTextContent(`${libraryAlbums[0]!.title}Album · ${libraryAlbums[0]!.artistCredit}`)
      expect(localStorage.getItem('squirmy.library.layout')).toBe('list')
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

  describe('empty', () => {
    it('says the heart is how music gets in', async () => {
      const fake = fakeServices()
      fake.api.catalog.albums.mockResolvedValue({ items: [], nextCursor: null })
      await renderLibrary('/library?filter=albums', fake)
      expect(await screen.findByRole('heading', { name: 'Add music to your library' })).toBeInTheDocument()
      expect(screen.getByText(/tap the heart\.$/)).toBeInTheDocument()
      expect(document.body.textContent).not.toMatch(/Add to library/)
    })

    it('still shows Liked Songs and the playlists under All', async () => {
      const fake = fakeServices()
      fake.api.catalog.albums.mockResolvedValue({ items: [], nextCursor: null })
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
