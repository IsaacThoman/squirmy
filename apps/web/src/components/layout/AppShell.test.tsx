import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useLocation, useNavigate } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AppRoutes } from '@/App'
import { album, likedTracks, playlistSummaries, track } from '@/fixtures/catalog'
import { users } from '@/fixtures/server'
import { fakeServices, type FakeOptions } from '@/test/fake-services'
import { renderWithApp } from '@/test/render'
import { DEFAULT_SIDEBAR_WIDTH, MOBILE_QUERY, SIDEBAR_COLLAPSED_WIDTH, SIDEBAR_MIN_WIDTH } from './sidebar-state'

const COLLAPSED_KEY = 'squirmy.sidebar.collapsed'
const WIDTH_KEY = 'squirmy.sidebar.width'

function Where() {
  const location = useLocation()
  return <output data-testid="where">{location.pathname + location.search}</output>
}
const where = () => screen.getByTestId('where').textContent

/** The signed-in app at `route`, once the shell is up. */
async function renderShell(route = '/', options?: FakeOptions) {
  const fake = fakeServices(options)
  const view = renderWithApp(<><AppRoutes /><Where /></>, route, fake.services)
  await screen.findByRole('main', { hidden: true })
  return { ...fake, ...view }
}

/** A shortcut with the platform's modifier: Ctrl here, ⌘ on a Mac. */
const press = (key: string, modifier: 'Control' | 'Meta' = 'Control') => userEvent.keyboard(`{${modifier}>}${key}{/${modifier}}`)

const sidebar = () => screen.getByLabelText('Sidebar')
const searchField = () => screen.findByRole('combobox', { name: 'Search' })
const settings = () => screen.findByRole('dialog', { name: 'Settings' })
const settingsSection = async () => within(await settings()).getAllByRole('heading', { level: 2 }).at(-1)?.textContent

/** Lays the app out as on a phone or a desktop, and lets a test resize the window across the two. */
function stubViewport(phone: boolean) {
  const listeners = new Set<() => void>()
  const viewport = { phone }
  vi.stubGlobal('matchMedia', (media: string) => ({
    media,
    get matches() { return media === MOBILE_QUERY && viewport.phone },
    addEventListener: (_type: string, listener: () => void) => { if (media === MOBILE_QUERY) listeners.add(listener) },
    removeEventListener: (_type: string, listener: () => void) => { listeners.delete(listener) },
  }))
  return (next: boolean) => {
    viewport.phone = next
    for (const listener of [...listeners]) listener()
  }
}

beforeEach(() => {
  localStorage.clear()
  // jsdom lays nothing out; the shell sizes the sidebar from its frame's width.
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1440)
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('AppShell', () => {
  it('puts the page beside the sidebar, with the user’s playlists and how many songs they like', async () => {
    await renderShell()
    expect(await screen.findByRole('heading', { level: 1, name: 'Listen now' })).toBeInTheDocument()
    expect(within(sidebar()).getByRole('navigation', { name: 'Main' })).toBeInTheDocument()
    const links = await within(sidebar()).findAllByRole('link', { name: /^(Liked Songs|After Dark|First Light|Late Train|Empty for now)/ })
    expect(links.map(link => link.getAttribute('href'))).toEqual(['/liked', ...playlistSummaries.map(playlist => `/playlist/${playlist.id}`)])
    expect(await within(sidebar()).findByRole('link', { name: `Liked Songs ${likedTracks.length} songs` })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Account, Alex Rivera' })).toBeInTheDocument()
  })

  it('moves focus to the page from “Skip to main content”', async () => {
    await renderShell()
    await userEvent.click(screen.getByRole('link', { name: 'Skip to main content' }))
    expect(screen.getByRole('main')).toHaveFocus()
    expect(where()).toBe('/')
  })

  it('opens the new playlist dialog from the sidebar', async () => {
    await renderShell()
    await userEvent.click(screen.getByRole('button', { name: 'New playlist' }))
    expect(await screen.findByRole('dialog', { name: 'New playlist' })).toBeInTheDocument()
  })

  describe('search', () => {
    it.each(['Control', 'Meta'] as const)('opens with %s+K and closes the same way', async modifier => {
      await renderShell()
      await press('k', modifier)
      expect(await screen.findByRole('dialog', { name: 'Search' })).toBeInTheDocument()
      expect(await searchField()).toHaveFocus()
      await press('k', modifier)
      expect(screen.queryByRole('dialog', { name: 'Search' })).not.toBeInTheDocument()
    })

    it('gives focus back to what had it when closed', async () => {
      await renderShell()
      const home = screen.getByRole('link', { name: 'Home' })
      home.focus()
      await press('k')
      await userEvent.type(await searchField(), 'blue')
      await userEvent.keyboard('{Escape}')
      await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Search' })).not.toBeInTheDocument())
      await waitFor(() => expect(home).toHaveFocus())
    })

    it('searches everything as you type and opens the best match with Enter', async () => {
      const { api } = await renderShell()
      await press('k')
      await userEvent.type(await searchField(), 'blue hour')
      const options = within(await screen.findByRole('listbox', { name: 'Results' }))
      expect(await options.findByRole('option', { name: 'Blue Hour Album · Mira Vale' })).toBeInTheDocument()
      expect(api.search.library).toHaveBeenLastCalledWith({ q: 'blue hour', limit: 20 }, expect.anything())
      await waitFor(() => expect(api.search.catalog).toHaveBeenLastCalledWith({ q: 'blue hour', limit: 20 }, expect.anything()))
      expect(options.getAllByRole('option')[0]).toHaveAccessibleName('Blue Hour Album · Mira Vale')
      expect(options.getAllByRole('option').at(-1)).toHaveAccessibleName('See all results for “blue hour”')

      await userEvent.keyboard('{Enter}')
      expect(where()).toBe(`/album/${album('blue-hour').id}`)
      expect(screen.queryByRole('dialog', { name: 'Search' })).not.toBeInTheDocument()
    })

    it('plays a song chosen from the results and stays on the page', async () => {
      const { socket } = await renderShell('/library?filter=albums')
      await press('k')
      await userEvent.type(await searchField(), 'amber')
      await userEvent.click(await screen.findByRole('option', { name: 'Amber Song · Lune Park' }))
      await waitFor(() => expect(socket.session.current?.trackId).toBe(track('amber').id))
      expect(socket.session.context).toMatchObject({ type: 'search' })
      expect(where()).toBe('/library?filter=albums')
      expect(screen.queryByRole('dialog', { name: 'Search' })).not.toBeInTheDocument()
    })

    it('goes to the search page for everything else', async () => {
      await renderShell()
      await press('k')
      await userEvent.type(await searchField(), 'pale & blue')
      await userEvent.click(await screen.findByRole('option', { name: 'See all results for “pale & blue”' }))
      expect(where()).toBe('/search?q=pale%20%26%20blue')
    })

    it('goes to a place chosen before anything is typed', async () => {
      await renderShell()
      await press('k')
      const places = within(await screen.findByRole('listbox', { name: 'Go to' }))
      expect(places.getAllByRole('option').map(option => option.textContent)).toEqual([
        expect.stringMatching(/^Home/), 'Search and browse genres', 'Library', 'Albums', 'Artists', 'Songs', 'Playlists', 'Liked Songs', 'Wantlist', 'Add music', 'Admin panel',
      ])
      await userEvent.click(places.getByRole('option', { name: 'Artists' }))
      expect(where()).toBe('/library?filter=artists')
      expect(screen.queryByRole('dialog', { name: 'Search' })).not.toBeInTheDocument()
    })

    it('offers Add music and the admin panel only to those who may use them', async () => {
      await renderShell('/', { user: users[2] })
      await press('k')
      const places = within(await screen.findByRole('listbox', { name: 'Go to' }))
      expect(places.getByRole('option', { name: 'Wantlist' })).toBeInTheDocument()
      expect(places.queryByRole('option', { name: 'Add music' })).not.toBeInTheDocument()
      expect(places.queryByRole('option', { name: 'Admin panel' })).not.toBeInTheDocument()
    })

    it('starts empty each time it is opened', async () => {
      await renderShell()
      await press('k')
      await userEvent.type(await searchField(), 'blue hour')
      await screen.findByRole('option', { name: 'Blue Hour Album · Mira Vale' })
      await userEvent.keyboard('{Escape}')
      expect(screen.queryByRole('dialog', { name: 'Search' })).not.toBeInTheDocument()

      await press('k')
      expect(await searchField()).toHaveValue('')
      expect(screen.getByRole('listbox', { name: 'Go to' })).toBeInTheDocument()
    })

    it('does not offer what an earlier search found while a new one is on its way', async () => {
      const { api } = await renderShell()
      await press('k')
      await userEvent.type(await searchField(), 'blue hour')
      await screen.findByRole('option', { name: 'Blue Hour Album · Mira Vale' })
      await userEvent.keyboard('{Escape}')

      api.search.library.mockReturnValue(new Promise<never>(() => {}))
      api.search.catalog.mockReturnValue(new Promise<never>(() => {}))
      await press('k')
      await userEvent.type(await searchField(), 'amber')
      await waitFor(() => expect(api.search.library).toHaveBeenLastCalledWith({ q: 'amber', limit: 20 }, expect.anything()))
      expect(screen.getByRole('status', { name: 'Searching' })).toBeInTheDocument()
      expect(screen.getAllByRole('option')).toHaveLength(1)
      // Enter before the answer is in searches for what was typed.
      await userEvent.keyboard('{Enter}')
      expect(where()).toBe('/search?q=amber')
    })

    it('does not open what the last search found when a new one is typed over it and Enter comes before its answer', async () => {
      const { api } = await renderShell()
      await press('k')
      const field = await searchField()
      await userEvent.type(field, 'blue hour')
      await screen.findByRole('option', { name: 'Blue Hour Album · Mira Vale' })

      api.search.library.mockReturnValue(new Promise<never>(() => {}))
      api.search.catalog.mockReturnValue(new Promise<never>(() => {}))
      await userEvent.clear(field)
      await userEvent.type(field, 'amber')
      await waitFor(() => expect(api.search.library).toHaveBeenLastCalledWith({ q: 'amber', limit: 20 }, expect.anything()))
      await userEvent.keyboard('{Enter}')
      expect(where()).toBe('/search?q=amber')
    })

    it('closes Now Playing when a result chosen over it opens another page', async () => {
      await renderShell()
      await press('k')
      await userEvent.type(await searchField(), 'amber')
      await userEvent.click(await screen.findByRole('option', { name: 'Amber Song · Lune Park' }))
      await userEvent.click(await screen.findByRole('button', { name: 'Open Now Playing' }))
      expect(await screen.findByRole('dialog', { name: 'Now Playing' })).toBeInTheDocument()
      await press('k')
      await userEvent.type(await searchField(), 'blue hour')
      await userEvent.click(await screen.findByRole('option', { name: 'Blue Hour Album · Mira Vale' }))
      expect(where()).toBe(`/album/${album('blue-hour').id}`)
      expect(screen.queryByRole('dialog', { name: 'Now Playing' })).not.toBeInTheDocument()
    }, 15_000)
  })

  describe('settings', () => {
    it.each(['Control', 'Meta'] as const)('open with %s+,', async modifier => {
      await renderShell()
      await press(',', modifier)
      expect(await settings()).toBeInTheDocument()
      expect(await settingsSection()).toBe('Playback')
      expect(where()).toBe('/')
    })

    it('open from the account menu', async () => {
      await renderShell()
      await userEvent.click(screen.getByRole('button', { name: 'Account, Alex Rivera' }))
      await userEvent.click(await screen.findByRole('menuitem', { name: 'Settings' }))
      expect(await settings()).toBeInTheDocument()
    })

    it('give focus back to the account button when opened from its menu, and to what had it when opened with the shortcut', async () => {
      await renderShell()
      const account = screen.getByRole('button', { name: 'Account, Alex Rivera' })
      await userEvent.click(account)
      await userEvent.click(await screen.findByRole('menuitem', { name: 'Settings' }))
      await userEvent.click(within(await settings()).getByRole('button', { name: 'Close' }))
      await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Settings' })).not.toBeInTheDocument())
      await waitFor(() => expect(account).toHaveFocus())

      const home = screen.getByRole('link', { name: 'Home' })
      home.focus()
      await press(',')
      await settings()
      await userEvent.keyboard('{Escape}')
      await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Settings' })).not.toBeInTheDocument())
      await waitFor(() => expect(home).toHaveFocus())
    })

    it('open over the home page at /settings', async () => {
      await renderShell('/settings')
      expect(await settings()).toBeInTheDocument()
      expect(await settingsSection()).toBe('Playback')
      await waitFor(() => expect(where()).toBe('/'))
      expect(await screen.findByRole('heading', { level: 1, name: 'Listen now', hidden: true })).toBeInTheDocument()
    })

    it.each([
      ['/settings/appearance', 'Appearance'],
      ['/settings/account', 'Account'],
      ['/settings/scrobbling', 'Scrobbling'],
      ['/settings/app-passwords', 'App passwords'],
      ['/settings/about', 'About'],
      ['/settings/playback', 'Playback'],
      ['/settings/nothing-like-this', 'Playback'],
    ])('open at %s on %s', async (route, section) => {
      await renderShell(route)
      expect(await settingsSection()).toBe(section)
      await waitFor(() => expect(where()).toBe('/'))
    })

    it('open on Scrobbling and say there that Last.fm sent the browser back connected', async () => {
      await renderShell('/settings?lastfm=connected')
      expect(await settingsSection()).toBe('Scrobbling')
      const said = await within(await settings()).findByText('Connected to Last.fm.')
      expect(said.closest('[role="status"]')).not.toBeNull()
      await waitFor(() => expect(where()).toBe('/'))
    })

    it.each([
      ['denied', 'Last.fm was not connected. The connection was not approved.'],
      ['invalid_state', 'That Last.fm link expired. Start connecting again.'],
      ['error', 'Last.fm did not answer. Try again in a moment.'],
      ['something-new', 'Last.fm did not answer. Try again in a moment.'],
    ])('say in Scrobbling what went wrong when Last.fm sends the browser back with “%s”', async (result, notice) => {
      await renderShell(`/settings?lastfm=${result}`)
      expect(await settingsSection()).toBe('Scrobbling')
      expect(await within(await settings()).findByText(notice)).toBeInTheDocument()
    })

    it('let Last.fm’s answer go once the dialog closes', async () => {
      await renderShell('/settings?lastfm=connected')
      const dialog = await settings()
      expect(await within(dialog).findByText('Connected to Last.fm.')).toBeInTheDocument()
      await userEvent.keyboard('{Escape}')
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
      await press(',')
      await userEvent.click(within(await settings()).getByRole('button', { name: 'Scrobbling' }))
      expect(within(await settings()).queryByText('Connected to Last.fm.')).toBeNull()
    })

    it('show the server’s name and version under About', async () => {
      await renderShell('/settings/about', { status: { serverName: 'Basement', version: '1.4.2' } })
      const about = within(await settings())
      expect(await about.findByText('Basement')).toBeInTheDocument()
      expect(about.getByText('Squirmy 1.4.2')).toBeInTheDocument()
    })

    it('save a changed playback setting', async () => {
      const { api } = await renderShell('/settings')
      await userEvent.click(await within(await settings()).findByRole('combobox', { name: 'Volume normalization' }))
      await userEvent.click(await screen.findByRole('option', { name: 'Off' }))
      await waitFor(() => expect(api.userdata.updateSettings).toHaveBeenCalledWith({ normalization: 'off' }))
      expect(await within(await settings()).findByRole('combobox', { name: 'Volume normalization' })).toHaveTextContent('Off')
    })

    it('take an admin to the admin panel and close', async () => {
      // The admin pages load on demand, and a page that starts loading inside a click never
      // arrives under React's test renderer. Starting there has them loaded, as on any later visit.
      await renderShell('/admin/library')
      await screen.findByRole('heading', { level: 1, name: 'Admin' })
      await userEvent.click(screen.getByRole('link', { name: 'Home' }))
      expect(where()).toBe('/')

      await press(',')
      await userEvent.click(within(await settings()).getByRole('button', { name: 'Admin panel' }))
      await waitFor(() => expect(where()).toBe('/admin/library'))
      expect(screen.queryByRole('dialog', { name: 'Settings' })).not.toBeInTheDocument()
    })

    it('do not offer the admin panel to a member', async () => {
      await renderShell('/settings', { user: users[1] })
      expect(within(await settings()).queryByRole('button', { name: 'Admin panel' })).not.toBeInTheDocument()
    })
  })

  describe('sidebar', () => {
    const folded = () => screen.queryByRole('button', { name: 'Close sidebar' }) === null

    it.each(['Control', 'Meta'] as const)('folds and opens with %s+B, and remembers which', async modifier => {
      await renderShell()
      expect(folded()).toBe(false)
      await press('b', modifier)
      expect(folded()).toBe(true)
      expect(screen.getByRole('button', { name: 'Open sidebar' })).toBeInTheDocument()
      // Folded, the playlists stay as covers; only their heading and New playlist go.
      expect(screen.getByRole('list', { name: 'Playlists' })).toBeInTheDocument()
      expect(screen.queryByRole('button', { name: 'New playlist' })).not.toBeInTheDocument()
      expect(screen.getByRole('link', { name: 'Library' })).toBeInTheDocument()
      expect(localStorage.getItem(COLLAPSED_KEY)).toBe('1')

      await press('b', modifier)
      expect(folded()).toBe(false)
      expect(screen.getByRole('button', { name: 'New playlist' })).toBeInTheDocument()
      expect(localStorage.getItem(COLLAPSED_KEY)).toBe('0')
    })

    it('keeps the keyboard on the toggle when the shortcut folds and opens it', async () => {
      await renderShell()
      screen.getByRole('button', { name: 'Close sidebar' }).focus()
      await press('b', 'Meta')
      expect(screen.getByRole('button', { name: 'Open sidebar' })).toHaveFocus()
      await press('b', 'Meta')
      expect(screen.getByRole('button', { name: 'Close sidebar' })).toHaveFocus()
    })

    it('folds and opens from its own buttons, and remembers which', async () => {
      await renderShell()
      await userEvent.click(screen.getByRole('button', { name: 'Close sidebar' }))
      expect(folded()).toBe(true)
      expect(localStorage.getItem(COLLAPSED_KEY)).toBe('1')
      await userEvent.click(screen.getByRole('button', { name: 'Open sidebar' }))
      expect(folded()).toBe(false)
      expect(localStorage.getItem(COLLAPSED_KEY)).toBe('0')
    })

    it('comes back folded when it was left folded', async () => {
      localStorage.setItem(COLLAPSED_KEY, '1')
      await renderShell()
      expect(folded()).toBe(true)
      expect(screen.getByRole('button', { name: 'Open sidebar' })).toBeInTheDocument()
    })

    it('leaves the sidebar alone when Ctrl+B is pressed while writing rich text', async () => {
      await renderShell()
      const editor = document.createElement('div')
      editor.setAttribute('contenteditable', 'true')
      screen.getByRole('main').appendChild(editor)
      fireEvent.keyDown(editor, { key: 'b', ctrlKey: true })
      expect(folded()).toBe(false)
      editor.remove()
    })

    describe('edge', () => {
      const edge = () => screen.getByRole('separator', { name: 'Resize sidebar' })
      const width = () => document.documentElement.style.getPropertyValue('--sidebar-width')
      const drag = (from: number, ...to: number[]) => {
        fireEvent.pointerDown(edge(), { button: 0, pointerId: 1, clientX: from })
        for (const clientX of to) fireEvent.pointerMove(edge(), { pointerId: 1, clientX })
        fireEvent.pointerUp(edge(), { pointerId: 1, clientX: to.at(-1) })
      }

      it('starts at the default width, or the one it was left at', async () => {
        const first = await renderShell()
        expect(width()).toBe(`${DEFAULT_SIDEBAR_WIDTH}px`)
        expect(edge()).toHaveAttribute('aria-valuenow', String(DEFAULT_SIDEBAR_WIDTH))
        first.unmount()

        localStorage.setItem(WIDTH_KEY, '320')
        await renderShell()
        expect(width()).toBe('320px')
        expect(edge()).toHaveAttribute('aria-valuenow', '320')
      })

      it('has its saved width before anything is laid out, so it does not animate to it on load', async () => {
        localStorage.setItem(WIDTH_KEY, '320')
        document.documentElement.style.removeProperty('--sidebar-width')
        const seen: string[] = []
        vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(() => {
          seen.push(width())
          return 1440
        })
        await renderShell()
        expect(seen[0]).toBe('320px')
      })

      it('resizes the sidebar as it is dragged and remembers the width', async () => {
        await renderShell()
        drag(DEFAULT_SIDEBAR_WIDTH, 300, 330)
        expect(width()).toBe('330px')
        expect(edge()).toHaveAttribute('aria-valuenow', '330')
        expect(localStorage.getItem(WIDTH_KEY)).toBe('330')
      })

      it('stops at the narrowest and the widest sidebar', async () => {
        await renderShell()
        drag(DEFAULT_SIDEBAR_WIDTH, 900)
        expect(width()).toBe(`${edge().getAttribute('aria-valuemax')}px`)
        drag(Number(edge().getAttribute('aria-valuemax')), SIDEBAR_MIN_WIDTH - 20)
        expect(width()).toBe(`${SIDEBAR_MIN_WIDTH}px`)
      })

      it('settles on the default width when dragged close to it', async () => {
        localStorage.setItem(WIDTH_KEY, '320')
        await renderShell()
        drag(320, DEFAULT_SIDEBAR_WIDTH + 5)
        expect(width()).toBe(`${DEFAULT_SIDEBAR_WIDTH}px`)
        expect(localStorage.getItem(WIDTH_KEY)).toBe(String(DEFAULT_SIDEBAR_WIDTH))
      })

      it('folds the sidebar when dragged in far enough, keeping its width for when it opens', async () => {
        localStorage.setItem(WIDTH_KEY, '320')
        await renderShell()
        drag(320, 240, 90)
        expect(folded()).toBe(true)
        expect(localStorage.getItem(COLLAPSED_KEY)).toBe('1')
        expect(edge()).toHaveAttribute('aria-valuenow', String(SIDEBAR_COLLAPSED_WIDTH))
        expect(localStorage.getItem(WIDTH_KEY)).toBe('320')

        await press('b')
        expect(folded()).toBe(false)
        expect(width()).toBe('320px')
      })

      it('stays open when a drag goes in past the fold point and comes back out', async () => {
        await renderShell()
        drag(DEFAULT_SIDEBAR_WIDTH, 90, 300)
        expect(folded()).toBe(false)
        expect(width()).toBe('300px')
        expect(localStorage.getItem(COLLAPSED_KEY)).toBe('0')
      })

      it('opens the folded sidebar as wide as its edge is dragged out', async () => {
        localStorage.setItem(COLLAPSED_KEY, '1')
        await renderShell()
        drag(SIDEBAR_COLLAPSED_WIDTH, 100)
        expect(folded()).toBe(true)

        drag(SIDEBAR_COLLAPSED_WIDTH, 140, 300)
        expect(folded()).toBe(false)
        expect(localStorage.getItem(COLLAPSED_KEY)).toBe('0')
        expect(width()).toBe('300px')
        expect(localStorage.getItem(WIDTH_KEY)).toBe('300')
      })

      it('goes back to the default width on a double click', async () => {
        localStorage.setItem(WIDTH_KEY, '320')
        await renderShell()
        await userEvent.dblClick(edge())
        expect(width()).toBe(`${DEFAULT_SIDEBAR_WIDTH}px`)
        expect(localStorage.getItem(WIDTH_KEY)).toBe(String(DEFAULT_SIDEBAR_WIDTH))
      })

      it('resizes with the arrow keys and folds with Enter', async () => {
        await renderShell()
        edge().focus()
        await userEvent.keyboard('{ArrowRight}')
        expect(width()).toBe(`${DEFAULT_SIDEBAR_WIDTH + 16}px`)
        await userEvent.keyboard('{ArrowLeft}{ArrowLeft}')
        expect(width()).toBe(`${DEFAULT_SIDEBAR_WIDTH - 16}px`)
        expect(localStorage.getItem(WIDTH_KEY)).toBe(String(DEFAULT_SIDEBAR_WIDTH - 16))
        await userEvent.keyboard('{Enter}')
        expect(folded()).toBe(true)
        await userEvent.keyboard('{Enter}')
        expect(folded()).toBe(false)
      })

      it('never squeezes the page under its minimum in a narrow window', async () => {
        vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(800)
        localStorage.setItem(WIDTH_KEY, '380')
        await renderShell()
        expect(width()).toBe('320px')
        expect(edge()).toHaveAttribute('aria-valuemax', '320')
        // The width that was chosen is kept for a wider window.
        expect(localStorage.getItem(WIDTH_KEY)).toBe('380')
      })
    })
  })

  describe('queue', () => {
    it('opens beside the page from the player bar and closes again', async () => {
      await renderShell()
      expect(screen.queryByRole('complementary', { name: 'Queue' })).not.toBeInTheDocument()
      await userEvent.click(screen.getByRole('button', { name: 'Queue' }))
      const queue = screen.getByRole('complementary', { name: 'Queue' })
      expect(queue).toBeInTheDocument()
      await userEvent.click(screen.getByRole('button', { name: 'Hide queue' }))
      expect(screen.queryByRole('complementary', { name: 'Queue' })).not.toBeInTheDocument()

      await userEvent.click(screen.getByRole('button', { name: 'Queue' }))
      await userEvent.click(within(screen.getByRole('complementary', { name: 'Queue' })).getByRole('button', { name: 'Close queue' }))
      expect(screen.queryByRole('complementary', { name: 'Queue' })).not.toBeInTheDocument()
      // Focus goes back to the button that opened it, not to the page's body.
      await waitFor(() => expect(screen.getByRole('button', { name: 'Queue' })).toHaveFocus())
    })

    it('floats as a modal below 1280px: the shell is out of reach, Tab stays in it, and Escape gives focus back', async () => {
      vi.stubGlobal('matchMedia', (media: string) => ({
        media,
        matches: media.includes('max-width: 1279.98px'),
        addEventListener: () => {},
        removeEventListener: () => {},
      }))
      await renderShell()
      const toggle = screen.getByRole('button', { name: 'Queue' })
      await userEvent.click(toggle)
      const queue = screen.getByRole('dialog', { name: 'Queue' })
      expect(queue).toHaveAttribute('aria-modal', 'true')
      await waitFor(() => expect(queue).toContainElement(document.activeElement as HTMLElement))
      expect(screen.getByRole('main', { hidden: true }).closest('[inert]')).not.toBeNull()
      expect(sidebar().closest('[inert]')).not.toBeNull()
      expect(toggle.closest('[inert]')).not.toBeNull()
      for (let i = 0; i < 6; i++) {
        await userEvent.tab()
        expect(queue).toContainElement(document.activeElement as HTMLElement)
      }
      await userEvent.keyboard('{Escape}')
      expect(screen.queryByRole('dialog', { name: 'Queue' })).not.toBeInTheDocument()
      expect(screen.getByRole('main').closest('[inert]')).toBeNull()
      await waitFor(() => expect(screen.getByRole('button', { name: 'Queue' })).toHaveFocus())
    })
  })

  describe('Now Playing', () => {
    it('slides with scrolling content and leaves wheel input inside the queue alone', async () => {
      await renderShell()
      const bar = screen.getByRole('region', { name: 'Player' })
      fireEvent.wheel(bar, { deltaY: 100 })
      expect(screen.queryByRole('dialog', { name: 'Now Playing' })).toBeNull()

      await press('k')
      await userEvent.type(await searchField(), 'amber')
      await userEvent.click(await screen.findByRole('option', { name: 'Amber Song · Lune Park' }))
      fireEvent.wheel(bar, { deltaY: -100 })
      fireEvent.wheel(bar, { deltaY: 100, ctrlKey: true })
      fireEvent.wheel(bar, { deltaX: 100, deltaY: 40 })
      fireEvent.wheel(bar, { deltaY: 16 })
      expect(screen.queryByRole('dialog', { name: 'Now Playing' })).toBeNull()
      fireEvent.wheel(bar, { deltaY: 20 })

      const dialog = await screen.findByRole('dialog', { name: 'Now Playing' })
      fireEvent.wheel(dialog, { deltaY: 100 })
      expect(dialog).toBeInTheDocument()
      await userEvent.click(within(dialog).getByRole('button', { name: 'Show queue' }))
      fireEvent.wheel(within(dialog).getByText('Up next'), { deltaY: -100 })
      expect(dialog).toBeInTheDocument()
      const showLyrics = within(dialog).getByRole('button', { name: 'Show lyrics' })
      const lyrics = document.getElementById(showLyrics.getAttribute('aria-controls')!)
      const queue = within(dialog).getByText('Up next').closest('[data-now-playing-scroll]')
      expect(lyrics).toHaveAttribute('inert')
      expect(queue).not.toHaveAttribute('inert')
      await userEvent.click(showLyrics)
      expect(queue).toHaveAttribute('inert')
      expect(lyrics).not.toHaveAttribute('inert')
      await userEvent.click(within(dialog).getByRole('button', { name: 'Hide lyrics' }))
      expect(queue).toHaveAttribute('inert')
      expect(lyrics).toHaveAttribute('inert')
      fireEvent.wheel(dialog, { deltaY: -100 })
      await waitFor(() => expect(dialog).not.toBeInTheDocument())
    }, 15_000)

    it('gives focus back to what opened it when it closes', async () => {
      await renderShell()
      await press('k')
      await userEvent.type(await searchField(), 'amber')
      await userEvent.click(await screen.findByRole('option', { name: 'Amber Song · Lune Park' }))
      const opener = await screen.findByRole('button', { name: 'Now Playing' })
      opener.focus()
      await userEvent.keyboard('{Enter}')
      expect(await screen.findByRole('dialog', { name: 'Now Playing' })).toBeInTheDocument()
      await userEvent.keyboard('{Escape}')
      await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Now Playing' })).not.toBeInTheDocument())
      expect(document.activeElement).toBe(opener)
    }, 15_000)

    it('reopens with the last pane, and keeps artwork selected after the pane is hidden', async () => {
      await renderShell()
      await press('k')
      await userEvent.type(await searchField(), 'amber')
      await userEvent.click(await screen.findByRole('option', { name: 'Amber Song · Lune Park' }))
      const opener = await screen.findByRole('button', { name: 'Now Playing' })
      await userEvent.click(opener)
      for (const pane of ['queue', 'lyrics']) {
        const dialog = await screen.findByRole('dialog', { name: 'Now Playing' })
        await userEvent.click(within(dialog).getByRole('button', { name: `Show ${pane}` }))
        await userEvent.click(within(dialog).getByRole('button', { name: 'Close Now Playing' }))
        await waitFor(() => expect(dialog).not.toBeInTheDocument())
        await userEvent.click(opener)
        const reopened = await screen.findByRole('dialog', { name: 'Now Playing' })
        const toggle = within(reopened).getByRole('button', { name: `Hide ${pane}` })
        expect(toggle).toHaveAttribute('aria-pressed', 'true')
        await userEvent.click(toggle)
      }
      await userEvent.keyboard('{Escape}')
      await userEvent.click(opener)
      const reopened = await screen.findByRole('dialog', { name: 'Now Playing' })
      expect(within(reopened).getByRole('button', { name: 'Show lyrics' })).toBeInTheDocument()
      expect(within(reopened).getByRole('button', { name: 'Show queue' })).toBeInTheDocument()
    }, 15_000)
  })

  describe('on a phone', () => {
    const opener = () => screen.getByRole('button', { name: 'Open sidebar' })
    const drawerOpen = () => !sidebar().hasAttribute('inert')

    it('puts a bar with the page\'s title behind the drawer button once a page with no header bar scrolls', async () => {
      stubViewport(true)
      const blueHour = album('blue-hour')
      await renderShell(`/album/${blueHour.id}`)
      await screen.findByRole('heading', { level: 1, name: 'Blue Hour' })
      const main = screen.getByRole('main')
      const bar = () => document.querySelector('[aria-hidden][class*="backdrop-blur"] span')
      expect(bar()).toBeNull()
      main.scrollTop = 300
      fireEvent.scroll(main)
      await waitFor(() => expect(bar()).toHaveTextContent('Blue Hour'))
      main.scrollTop = 0
      fireEvent.scroll(main)
      await waitFor(() => expect(bar()).toBeNull())
    })

    it('adds no bar over a page that has its own header bar', async () => {
      stubViewport(true)
      // Search keeps its field in the header on a phone; a title-only header leaves no bar.
      await renderShell('/search')
      const main = screen.getByRole('main')
      await waitFor(() => expect(main.querySelector('[data-page-header]')).not.toBeNull())
      main.scrollTop = 300
      fireEvent.scroll(main)
      await new Promise(resolve => requestAnimationFrame(resolve))
      expect(document.querySelector('[aria-hidden][class*="backdrop-blur"] span')).toBeNull()
    })

    it('keeps the sidebar away as a closed drawer', async () => {
      stubViewport(true)
      await renderShell()
      expect(drawerOpen()).toBe(false)
      expect(screen.queryByRole('complementary', { name: 'Sidebar' })).not.toBeInTheDocument()
      expect(screen.queryByRole('link', { name: 'Library' })).not.toBeInTheDocument()
      expect(opener()).toHaveAttribute('aria-expanded', 'false')
      expect(screen.getByRole('main')).toBeInTheDocument()
      expect(screen.queryByRole('separator', { name: 'Resize sidebar' })).not.toBeInTheDocument()
    })

    it('opens the drawer from “Open sidebar”, over a page that is out of reach meanwhile', async () => {
      stubViewport(true)
      await renderShell()
      await userEvent.click(opener())
      expect(drawerOpen()).toBe(true)
      const drawer = within(screen.getByRole('complementary', { name: 'Sidebar' }))
      expect(drawer.getByRole('link', { name: 'Library' })).toBeInTheDocument()
      expect(drawer.getByRole('list', { name: 'Playlists' })).toBeInTheDocument()
      expect(screen.getByRole('main').closest('[inert]')).not.toBeNull()
      await waitFor(() => expect(sidebar()).toContainElement(document.activeElement as HTMLElement))
    })

    it('closes the drawer on Escape and gives focus back to the button', async () => {
      stubViewport(true)
      await renderShell()
      await userEvent.click(opener())
      await waitFor(() => expect(sidebar()).toContainElement(document.activeElement as HTMLElement))
      await userEvent.keyboard('{Escape}')
      expect(drawerOpen()).toBe(false)
      expect(screen.getByRole('main').closest('[inert]')).toBeNull()
      await waitFor(() => expect(opener()).toHaveFocus())
    })

    it('closes the drawer after following a link', async () => {
      stubViewport(true)
      await renderShell()
      await userEvent.click(opener())
      await userEvent.click(within(sidebar()).getByRole('link', { name: 'Library' }))
      // The Library opens on the filter last chosen in this browser: All the first time.
      await waitFor(() => expect(where()).toBe('/library?filter=all'))
      expect(drawerOpen()).toBe(false)
    })

    it('closes the drawer when something other than one of its links leads to another page', async () => {
      stubViewport(true)
      await renderShell()
      await userEvent.click(opener())
      await userEvent.click(within(sidebar()).getByRole('button', { name: 'New playlist' }))
      const dialog = within(await screen.findByRole('dialog', { name: 'New playlist' }))
      expect(drawerOpen()).toBe(true)
      await userEvent.type(dialog.getByLabelText('Name'), 'Late night drive')
      await userEvent.click(dialog.getByRole('button', { name: 'Create' }))
      await waitFor(() => expect(where()).toMatch(/^\/playlist\//))
      expect(drawerOpen()).toBe(false)
    })

    it('closes the drawer from its own button and from the page behind it', async () => {
      stubViewport(true)
      await renderShell()
      await userEvent.click(opener())
      await userEvent.click(within(sidebar()).getByRole('button', { name: 'Close sidebar' }))
      expect(drawerOpen()).toBe(false)

      await userEvent.click(opener())
      const backdrop = sidebar().previousElementSibling as HTMLElement
      await userEvent.click(backdrop)
      expect(drawerOpen()).toBe(false)
    })

    it('keeps Tab inside the open drawer', async () => {
      stubViewport(true)
      await renderShell()
      await userEvent.click(opener())
      const account = within(sidebar()).getByRole('button', { name: 'Account, Alex Rivera' })
      account.focus()
      await userEvent.tab()
      expect(within(sidebar()).getByRole('link', { name: 'Squirmy home' })).toHaveFocus()
      await userEvent.tab({ shift: true })
      expect(account).toHaveFocus()
    })

    it('opens and closes the drawer with Ctrl+B without folding the desktop sidebar', async () => {
      stubViewport(true)
      await renderShell()
      await press('b')
      expect(drawerOpen()).toBe(true)
      await press('b')
      expect(drawerOpen()).toBe(false)
      expect(localStorage.getItem(COLLAPSED_KEY)).toBeNull()
    })

    it('closes the drawer when search or settings open over it', async () => {
      stubViewport(true)
      await renderShell()
      await userEvent.click(opener())
      await press('k')
      expect(await screen.findByRole('dialog', { name: 'Search' })).toBeInTheDocument()
      expect(drawerOpen()).toBe(false)
      await userEvent.keyboard('{Escape}')

      await userEvent.click(opener())
      await userEvent.click(within(sidebar()).getByRole('button', { name: 'Account, Alex Rivera' }))
      await userEvent.click(await screen.findByRole('menuitem', { name: 'Settings' }))
      expect(await settings()).toBeInTheDocument()
      expect(drawerOpen()).toBe(false)
    })

    it('shows the sidebar in full even when it was left folded on a desktop', async () => {
      localStorage.setItem(COLLAPSED_KEY, '1')
      stubViewport(true)
      await renderShell()
      await userEvent.click(opener())
      expect(within(sidebar()).getByRole('list', { name: 'Playlists' })).toBeInTheDocument()
      expect(within(sidebar()).getByRole('button', { name: 'Close sidebar' })).toBeInTheDocument()
    })

    it('turns the sidebar into a drawer, and back, as the window is resized', async () => {
      const setPhone = stubViewport(false)
      await renderShell()
      expect(screen.getByRole('complementary', { name: 'Sidebar' })).toBeInTheDocument()
      expect(screen.getByRole('separator', { name: 'Resize sidebar' })).toBeInTheDocument()

      act(() => setPhone(true))
      expect(await screen.findByRole('button', { name: 'Open sidebar' })).toBeInTheDocument()
      expect(drawerOpen()).toBe(false)

      await userEvent.click(opener())
      act(() => setPhone(false))
      await waitFor(() => expect(screen.getByRole('separator', { name: 'Resize sidebar' })).toBeInTheDocument())
      expect(screen.getByRole('complementary', { name: 'Sidebar' })).toBeInTheDocument()
      expect(screen.getByRole('main').closest('[inert]')).toBeNull()
    })
  })

  describe('scroll', () => {
    /** jsdom lays nothing out: the main column's scroll position is kept by hand, as tall as `height`. */
    function stubScroll(main: HTMLElement, height = { value: 5000 }) {
      let top = 0
      Object.defineProperty(main, 'scrollTop', {
        configurable: true,
        get: () => top,
        set: (value: number) => { top = Math.max(0, Math.min(value, height.value)) },
      })
      main.scrollTo = ((options: ScrollToOptions) => { main.scrollTop = options.top ?? 0 }) as typeof main.scrollTo
      return {
        scrollTo(value: number) {
          main.scrollTop = value
          fireEvent.scroll(main)
        },
        get top() { return top },
        height,
      }
    }

    /** Links and Back, as a reader would follow them; the shell's own links vary with the layout. */
    function Nav() {
      const navigate = useNavigate()
      return (
        <>
          <button type="button" onClick={() => void navigate('/library?filter=albums')}>to library</button>
          <button type="button" onClick={() => void navigate('/search')}>to search</button>
          <button type="button" onClick={() => void navigate('/search?q=soft', { replace: true })}>type a search</button>
          <button type="button" onClick={() => void navigate('/search?q=soft&type=artist', { replace: true })}>filter search</button>
          <button type="button" onClick={() => void navigate('/artist/00000000-0000-4000-8100-000000000001')}>to artist</button>
          <button type="button" onClick={() => void navigate(`/album/${album('blue-hour').id}`)}>to album</button>
          <button type="button" onClick={() => void navigate(1)}>forward</button>
          <button type="button" onClick={() => void navigate(-1)}>back</button>
        </>
      )
    }
    const go = (name: string) => fireEvent.click(screen.getByRole('button', { name, hidden: true }))

    it('starts a new page at the top, and Back returns to where each page was', async () => {
      renderWithApp(<><AppRoutes /><Where /><Nav /></>, '/', fakeServices().services)
      const scroll = stubScroll(await screen.findByRole('main', { hidden: true }))
      scroll.scrollTo(1368)
      go('to library')
      await waitFor(() => expect(where()).toBe('/library?filter=albums'))
      expect(scroll.top).toBe(0)
      scroll.scrollTo(400)
      go('to search')
      await waitFor(() => expect(where()).toBe('/search'))
      expect(scroll.top).toBe(0)
      go('back')
      await waitFor(() => expect(where()).toBe('/library?filter=albums'))
      await waitFor(() => expect(scroll.top).toBe(400))
      go('back')
      await waitFor(() => expect(where()).toBe('/'))
      await waitFor(() => expect(scroll.top).toBe(1368))
    })

    it('keeps the place when the address changes on the same page, and after it', async () => {
      renderWithApp(<><AppRoutes /><Where /><Nav /></>, '/search', fakeServices().services)
      const scroll = stubScroll(await screen.findByRole('main', { hidden: true }))
      scroll.scrollTo(550)
      go('type a search')
      await waitFor(() => expect(where()).toBe('/search?q=soft'))
      expect(scroll.top).toBe(550)
      go('to library')
      await waitFor(() => expect(where()).toBe('/library?filter=albums'))
      go('back')
      await waitFor(() => expect(where()).toBe('/search?q=soft'))
      await waitFor(() => expect(scroll.top).toBe(550))
    })

    it('takes a breadcrumb back to the artist, then to the filtered search at its scroll position', async () => {
      renderWithApp(<><AppRoutes /><Where /><Nav /></>, '/search', fakeServices().services)
      const scroll = stubScroll(await screen.findByRole('main', { hidden: true }))
      go('filter search')
      scroll.scrollTo(550)
      go('to artist')
      go('to album')
      go('Back to artist')
      expect(where()).toBe('/artist/00000000-0000-4000-8100-000000000001')
      go('Back to Search')
      expect(where()).toBe('/search?q=soft&type=artist')
      await waitFor(() => expect(scroll.top).toBe(550))
      go('forward')
      expect(screen.getByRole('button', { name: 'Back to Search' })).toBeInTheDocument()
    })

    it('leaves the breadcrumb out of a directly opened album', async () => {
      await renderShell(`/album/${album('blue-hour').id}`)
      expect(screen.queryByRole('navigation', { name: 'Back navigation' })).toBeNull()
    })

    it('waits for a page to grow tall enough before giving up on its place', async () => {
      renderWithApp(<><AppRoutes /><Where /><Nav /></>, '/', fakeServices().services)
      const scroll = stubScroll(await screen.findByRole('main', { hidden: true }))
      scroll.scrollTo(1800)
      go('to library')
      await waitFor(() => expect(where()).toBe('/library?filter=albums'))
      // The page comes back short (a list still loading), and grows a moment later.
      scroll.height.value = 300
      go('back')
      await waitFor(() => expect(where()).toBe('/'))
      expect(scroll.top).toBe(300)
      scroll.height.value = 5000
      await waitFor(() => expect(scroll.top).toBe(1800))
    })
  })
})
