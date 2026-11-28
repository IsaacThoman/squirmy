import { ApiError } from '@squirmy/client-core'
import type { PlaybackContext, PlaylistSummary, User } from '@squirmy/contracts'
import { fireEvent, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState, type ComponentProps, type ReactNode } from 'react'
import { useLocation } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { playlistSummaries, track } from '@/fixtures/catalog'
import { currentUser, users } from '@/fixtures/server'
import { endTrackDrag, startTrackDrag } from '@/lib/drag'
import { LibraryContext, type LibraryActions } from '@/player/library-context'
import { PlayerContext, usePlayer } from '@/player/player-context'
import { renderWithApp } from '@/test/render'
import { Sidebar } from './Sidebar'

const [afterDark, firstLight] = playlistSummaries
const [, sam, robin] = users
/** A playlist someone else shares with the server. */
const roadTrip: PlaylistSummary = { ...firstLight, id: '00000000-0000-4000-8400-0000000000aa', name: 'Road Trip', ownerId: sam.id, ownerName: sam.username, isPublic: true }
/** A smart playlist of your own: its songs come from rules. */
const jazz: PlaylistSummary = { ...afterDark, id: '00000000-0000-4000-8400-0000000000ab', name: 'Jazz', smart: true }
const playlists = [...playlistSummaries, roadTrip, jazz]

function Where() {
  const location = useLocation()
  return <output data-testid="where">{location.pathname}</output>
}
const where = () => screen.getByTestId('where').textContent

/** Plays from `context` instead of the fixture session's album. */
function PlayingFrom({ context, children }: { context?: PlaybackContext; children: ReactNode }) {
  const player = usePlayer()
  return <PlayerContext value={context ? { ...player, state: { ...player.state, context, playing: true } } : player}>{children}</PlayerContext>
}

type Options = Partial<ComponentProps<typeof Sidebar>> & {
  user?: User
  route?: string
  playingFrom?: PlaybackContext
  wantlistEnabled?: boolean
  /** Folds and opens for real, as the shell does, rather than only reporting the toggle. */
  toggles?: boolean
}

/** The sidebar holding its own folded state, as the shell keeps it. */
function Toggling(props: ComponentProps<typeof Sidebar>) {
  const [collapsed, setCollapsed] = useState(props.collapsed)
  return <Sidebar {...props} collapsed={collapsed} onToggle={() => { props.onToggle(); setCollapsed(value => !value) }} />
}

function renderSidebar({ route = '/', playingFrom, wantlistEnabled = true, toggles = false, ...props }: Options = {}) {
  const library = {
    wantlistEnabled,
    isWanted: () => false,
    setSaved: vi.fn<LibraryActions['setSaved']>(async () => {}),
    setWanted: vi.fn<LibraryActions['setWanted']>(async () => {}),
    playlists: playlistSummaries,
    ownPlaylists: playlistSummaries,
    addToPlaylist: vi.fn<LibraryActions['addToPlaylist']>(async () => true),
    newPlaylist: vi.fn<LibraryActions['newPlaylist']>(),
    sharingEnabled: false,
    share: vi.fn<LibraryActions['share']>(),
    newSmartPlaylist: vi.fn<LibraryActions['newSmartPlaylist']>(),
    showRatings: false,
    setRating: vi.fn<LibraryActions['setRating']>(async () => {}),
  } satisfies LibraryActions
  const on = { onToggle: vi.fn(), onNavigate: vi.fn(), onOpenSettings: vi.fn(), onPlayPlaylist: vi.fn(), onPlayLiked: vi.fn(), onLogout: vi.fn() }
  renderWithApp(
    <LibraryContext value={library}>
      <PlayingFrom context={playingFrom}>
        {(() => {
          const all = { user: currentUser, playlists, likedCount: '24 songs', collapsed: false, mobile: false, mobileOpen: false, ...on, ...props }
          return toggles ? <Toggling {...all} /> : <Sidebar {...all} />
        })()}
      </PlayingFrom>
      <Where />
    </LibraryContext>,
    route,
  )
  return { ...on, library }
}

const sidebar = () => screen.getByRole('complementary', { name: 'Sidebar' })
const mainNav = () => within(screen.getByRole('navigation', { name: 'Main' }))
const playlistLinks = () => within(screen.getByRole('list', { name: 'Playlists' })).getAllByRole('link')
const playlistLink = (name: string) => within(screen.getByRole('list', { name: 'Playlists' })).getByRole('link', { name })

/** jsdom has no DataTransfer; this holds what a drag carries. */
function dataTransfer(): DataTransfer {
  const data = new Map<string, string>()
  const transfer = {
    types: [] as string[],
    effectAllowed: 'uninitialized',
    dropEffect: 'none',
    setData(type: string, value: string) {
      data.set(type, value)
      transfer.types = [...data.keys()]
    },
    getData: (type: string) => data.get(type) ?? '',
  }
  return transfer as unknown as DataTransfer
}

/** Starts dragging songs out of a track list, as a row does. */
function dragTracks(...slugs: string[]) {
  const transfer = dataTransfer()
  const tracks = slugs.map(track)
  startTrackDrag({ dataTransfer: transfer }, { tracks, list: null, index: 0 })
  return { transfer, tracks }
}

afterEach(endTrackDrag)

describe('Sidebar', () => {
  it('links to every main page, with one Library for albums, artists and songs', () => {
    renderSidebar()
    const pages = [['Home', '/'], ['Search', '/search'], ['Library', '/library'], ['Replay', '/replay'], ['Wantlist', '/wantlist'], ['Add music', '/imports']]
    for (const [name, to] of pages) expect(mainNav().getByRole('link', { name })).toHaveAttribute('href', to)
    expect(mainNav().getAllByRole('link')).toHaveLength(pages.length)
    for (const name of ['Albums', 'Artists', 'Songs']) expect(within(sidebar()).queryByRole('link', { name })).toBeNull()
    expect(within(sidebar()).getByRole('link', { name: 'Squirmy home' })).toHaveAttribute('href', '/')
    expect(within(sidebar()).getByRole('link', { name: 'Playlists' })).toHaveAttribute('href', '/library?filter=playlists')
  })

  it('goes to a page and says a link was followed', async () => {
    const { onNavigate } = renderSidebar()
    await userEvent.click(mainNav().getByRole('link', { name: 'Library' }))
    expect(where()).toBe('/library')
    expect(onNavigate).toHaveBeenCalledTimes(1)
  })

  it('marks the page you are on, whatever the Library shows', () => {
    renderSidebar({ route: '/library?filter=artists' })
    expect(mainNav().getByRole('link', { name: 'Library' })).toHaveAttribute('aria-current', 'page')
    expect(mainNav().getByRole('link', { name: 'Home' })).not.toHaveAttribute('aria-current')
    expect(mainNav().getByRole('link', { name: 'Search' })).not.toHaveAttribute('aria-current')
  })

  it('leaves out the Wantlist while the server has it off', () => {
    renderSidebar({ wantlistEnabled: false })
    expect(mainNav().queryByRole('link', { name: 'Wantlist' })).not.toBeInTheDocument()
    expect(mainNav().getByRole('link', { name: 'Library' })).toBeInTheDocument()
  })

  it('offers Add music only to people who may upload', () => {
    renderSidebar({ user: robin })
    expect(mainNav().queryByRole('link', { name: 'Add music' })).not.toBeInTheDocument()
    expect(mainNav().getByRole('link', { name: 'Wantlist' })).toBeInTheDocument()
  })

  it('offers Add music to a member who may upload', () => {
    renderSidebar({ user: sam })
    expect(mainNav().getByRole('link', { name: 'Add music' })).toHaveAttribute('href', '/imports')
  })

  describe('account menu', () => {
    const openMenu = async (name: string) => {
      await userEvent.click(screen.getByRole('button', { name: `Account, ${name}` }))
      return within(await screen.findByRole('menu'))
    }

    it('offers Settings, Your uploads, Admin panel and Log out to an admin', async () => {
      renderSidebar()
      const menu = await openMenu('Alex Rivera')
      expect(menu.getAllByRole('menuitem').map(item => item.textContent)).toEqual([expect.stringMatching(/^Settings/), 'Your uploads', 'Admin panel', 'Log out'])
      expect(menu.getByRole('menuitem', { name: 'Settings' })).toBeInTheDocument()
      expect(menu.getByText('Alex Rivera · Admin')).toBeInTheDocument()
    })

    it('offers Admin panel only to admins', async () => {
      renderSidebar({ user: sam })
      const menu = await openMenu('Sam Okafor')
      // Sam may upload, so Your uploads is there.
      expect(menu.getAllByRole('menuitem').map(item => item.textContent)).toEqual([expect.stringMatching(/^Settings/), 'Your uploads', 'Log out'])
      expect(menu.getByText('Sam Okafor · Member')).toBeInTheDocument()
    })

    it('names someone without a display name by their username', async () => {
      renderSidebar({ user: robin })
      expect((await openMenu('robin')).getByText('robin · Member')).toBeInTheDocument()
    })

    it('opens Settings', async () => {
      const { onOpenSettings, onLogout } = renderSidebar()
      await userEvent.click((await openMenu('Alex Rivera')).getByRole('menuitem', { name: 'Settings' }))
      expect(onOpenSettings).toHaveBeenCalledTimes(1)
      expect(onLogout).not.toHaveBeenCalled()
      expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    })

    it('logs out', async () => {
      const { onLogout, onOpenSettings } = renderSidebar()
      await userEvent.click((await openMenu('Alex Rivera')).getByRole('menuitem', { name: 'Log out' }))
      expect(onLogout).toHaveBeenCalledTimes(1)
      expect(onOpenSettings).not.toHaveBeenCalled()
    })

    it('goes to the admin panel', async () => {
      const { onNavigate } = renderSidebar()
      await userEvent.click((await openMenu('Alex Rivera')).getByRole('menuitem', { name: 'Admin panel' }))
      expect(where()).toBe('/admin')
      expect(onNavigate).toHaveBeenCalledTimes(1)
    })

    it('opens from the keyboard', async () => {
      const { onOpenSettings } = renderSidebar()
      screen.getByRole('button', { name: 'Account, Alex Rivera' }).focus()
      await userEvent.keyboard('{Enter}')
      expect(await screen.findByRole('menu')).toBeInTheDocument()
      await userEvent.keyboard('{Enter}')
      expect(onOpenSettings).toHaveBeenCalledTimes(1)
    })
  })

  describe('playlists', () => {
    it('lists Liked Songs first, with its count, then the playlists in the order given', () => {
      renderSidebar()
      const links = playlistLinks()
      expect(links.map(link => link.getAttribute('href'))).toEqual(['/liked', ...playlists.map(playlist => `/playlist/${playlist.id}`)])
      expect(links[0]).toHaveAccessibleName('Liked Songs 24 songs')
      expect(links.slice(1).map(link => link.textContent)).toEqual(['After Dark', 'First Light', 'Late Train', 'Empty for now', 'Road Trip', 'Jazz'])
    })

    it('marks a smart playlist beside its name, leaving its name as the link’s', () => {
      renderSidebar()
      const link = playlistLink('Jazz')
      expect(link.querySelector('svg.lucide-sparkles')).not.toBeNull()
      expect(playlistLink('After Dark').querySelector('svg.lucide-sparkles')).toBeNull()
    })

    it('opens a playlist and says a link was followed', async () => {
      const { onNavigate } = renderSidebar()
      await userEvent.click(playlistLink('After Dark'))
      expect(where()).toBe(`/playlist/${afterDark.id}`)
      expect(onNavigate).toHaveBeenCalledTimes(1)
    })

    it('opens the new playlist dialog from New playlist', async () => {
      const { library } = renderSidebar()
      await userEvent.click(screen.getByRole('button', { name: 'New playlist' }))
      await userEvent.click(await screen.findByRole('menuitem', { name: 'Playlist' }))
      expect(library.newPlaylist).toHaveBeenCalledTimes(1)
      expect(library.newPlaylist.mock.calls[0]).toEqual([])
      expect(library.newSmartPlaylist).not.toHaveBeenCalled()
    })

    it('opens the new smart playlist dialog from New playlist', async () => {
      const { library } = renderSidebar()
      await userEvent.click(screen.getByRole('button', { name: 'New playlist' }))
      await userEvent.click(await screen.findByRole('menuitem', { name: 'Smart playlist' }))
      expect(library.newSmartPlaylist).toHaveBeenCalledTimes(1)
      expect(library.newPlaylist).not.toHaveBeenCalled()
    })

    it('plays a playlist from its right-click menu', async () => {
      const { onPlayPlaylist } = renderSidebar()
      fireEvent.contextMenu(playlistLink('After Dark'))
      await userEvent.click(await screen.findByRole('menuitem', { name: 'Play' }))
      expect(onPlayPlaylist).toHaveBeenCalledWith(afterDark)
      expect(where()).toBe('/')
    })

    it('plays Liked Songs from its right-click menu', async () => {
      const { onPlayLiked, onPlayPlaylist } = renderSidebar()
      fireEvent.contextMenu(playlistLink('Liked Songs 24 songs'))
      await userEvent.click(await screen.findByRole('menuitem', { name: 'Play' }))
      expect(onPlayLiked).toHaveBeenCalledTimes(1)
      expect(onPlayPlaylist).not.toHaveBeenCalled()
    })

    it('cannot play a playlist with nothing in it', async () => {
      renderSidebar()
      fireEvent.contextMenu(playlistLink('Empty for now'))
      expect(await screen.findByRole('menuitem', { name: 'Play' })).toHaveAttribute('aria-disabled', 'true')
    })

    it('marks the playlist that is playing, and only that one', () => {
      renderSidebar({ playingFrom: { type: 'playlist', id: afterDark.id, title: afterDark.name } })
      expect(within(playlistLink('After Dark Playing')).getByRole('img', { name: 'Playing' })).toBeInTheDocument()
      expect(within(screen.getByRole('list', { name: 'Playlists' })).getAllByRole('img', { name: 'Playing' })).toHaveLength(1)
      expect(playlistLink('Liked Songs 24 songs')).toBeInTheDocument()
    })

    it('shows that Liked Songs is playing in place of its count', () => {
      renderSidebar({ playingFrom: { type: 'liked', id: null, title: 'Liked Songs' } })
      expect(playlistLink('Liked Songs Playing')).toBeInTheDocument()
      expect(screen.queryByText('24 songs')).not.toBeInTheDocument()
    })
  })

  describe('dragging songs', () => {
    it('adds the songs dropped on a playlist of your own, and says on the row that they went in', async () => {
      const { library } = renderSidebar()
      const { transfer, tracks } = dragTracks('amber', 'riverside')
      const link = playlistLink('After Dark')
      // A drop target says so by cancelling dragover.
      expect(fireEvent.dragOver(link, { dataTransfer: transfer })).toBe(false)
      expect(transfer.dropEffect).toBe('copy')
      fireEvent.drop(link, { dataTransfer: transfer })
      expect(library.addToPlaylist).toHaveBeenCalledTimes(1)
      expect(library.addToPlaylist).toHaveBeenCalledWith(afterDark, tracks)
      expect(where()).toBe('/')
      expect(await within(link).findByText('Added')).toBeInTheDocument()
      expect(screen.getAllByRole('status').map(status => status.textContent)).toContain('Added to After Dark')
    })

    it('says on the row when the server refused the songs dropped on it', async () => {
      const { library } = renderSidebar()
      library.addToPlaylist.mockRejectedValueOnce(new ApiError(503, 'unavailable', 'The server is busy.'))
      const { transfer } = dragTracks('amber')
      const link = playlistLink('After Dark')
      fireEvent.dragOver(link, { dataTransfer: transfer })
      fireEvent.drop(link, { dataTransfer: transfer })
      expect(await within(link).findByText('Couldn’t add')).toBeInTheDocument()
      expect(screen.getAllByRole('status').map(status => status.textContent)).toContain('Couldn’t add to After Dark. The server is busy.')
    })

    it('does not take songs on a smart playlist, whose songs come from its rules', () => {
      const { library } = renderSidebar()
      const { transfer } = dragTracks('amber')
      const link = playlistLink('Jazz')
      expect(fireEvent.dragOver(link, { dataTransfer: transfer })).toBe(true)
      fireEvent.drop(link, { dataTransfer: transfer })
      expect(library.addToPlaylist).not.toHaveBeenCalled()
    })

    it('does not take songs on someone else’s playlist', () => {
      const { library } = renderSidebar()
      const { transfer } = dragTracks('amber')
      const link = playlistLink('Road Trip')
      expect(fireEvent.dragOver(link, { dataTransfer: transfer })).toBe(true)
      fireEvent.drop(link, { dataTransfer: transfer })
      expect(library.addToPlaylist).not.toHaveBeenCalled()
    })

    it('saves the songs dropped on Liked Songs that are not saved yet, and says on the row once they are', async () => {
      const { library } = renderSidebar()
      const { transfer } = dragTracks('amber', 'riverside', 'open-window')
      const link = playlistLink('Liked Songs 24 songs')
      expect(fireEvent.dragOver(link, { dataTransfer: transfer })).toBe(false)
      fireEvent.drop(link, { dataTransfer: transfer })
      const saved = (slug: string) => [{ type: 'track', id: track(slug).id, title: track(slug).title }, true]
      expect(library.setSaved.mock.calls).toEqual([saved('riverside'), saved('open-window')])
      expect(library.addToPlaylist).not.toHaveBeenCalled()
      expect(await within(link).findByText('Saved')).toBeInTheDocument()
    })

    it('ignores a drag of anything else', () => {
      const { library } = renderSidebar()
      dragTracks('amber')
      const files = dataTransfer()
      files.setData('text/plain', 'Amber – Lune Park')
      const link = playlistLink('After Dark')
      expect(fireEvent.dragOver(link, { dataTransfer: files })).toBe(true)
      fireEvent.drop(link, { dataTransfer: files })
      expect(library.addToPlaylist).not.toHaveBeenCalled()
    })

    it('takes nothing once the drag has ended', () => {
      const { library } = renderSidebar()
      const { transfer } = dragTracks('amber')
      endTrackDrag()
      const link = playlistLink('After Dark')
      expect(fireEvent.dragOver(link, { dataTransfer: transfer })).toBe(true)
      fireEvent.drop(link, { dataTransfer: transfer })
      expect(library.addToPlaylist).not.toHaveBeenCalled()
    })
  })

  describe('folded to a rail', () => {
    it('keeps the navigation and the account menu reachable by name', () => {
      renderSidebar({ collapsed: true })
      for (const name of ['Home', 'Search', 'Library', 'Wantlist', 'Add music']) {
        expect(mainNav().getByRole('link', { name })).toBeInTheDocument()
      }
      expect(screen.getByRole('button', { name: 'Account, Alex Rivera' })).toBeInTheDocument()
    })

    it('keeps Liked Songs and every playlist as a cover, named and in reach of the keyboard', async () => {
      renderSidebar({ collapsed: true })
      const links = playlistLinks()
      expect(links.map(link => link.textContent)).toEqual(['Liked Songs24 songs', ...playlists.map(playlist => playlist.name)])
      for (const link of links) expect(link.closest('[inert]')).toBeNull()
      expect(playlistLink('Road Trip')).not.toHaveAttribute('title')
      await userEvent.hover(playlistLink('Road Trip'))
      playlistLink('Road Trip').focus()
      expect(playlistLink('Road Trip')).toHaveFocus()
      expect(screen.queryByRole('tooltip')).toBeNull()
    })

    it('leaves out the playlists’ heading and New playlist', () => {
      renderSidebar({ collapsed: true })
      expect(screen.queryByRole('button', { name: 'New playlist' })).not.toBeInTheDocument()
      expect(screen.queryByRole('link', { name: 'Playlists' })).not.toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'New playlist', hidden: true }).closest('[inert]')).not.toBeNull()
    })

    it('opens a playlist from its cover', async () => {
      const { onNavigate } = renderSidebar({ collapsed: true })
      await userEvent.click(playlistLink('Road Trip'))
      expect(where()).toBe(`/playlist/${roadTrip.id}`)
      expect(onNavigate).toHaveBeenCalled()
    })

    it('opens again from the logo', async () => {
      const { onToggle } = renderSidebar({ collapsed: true })
      expect(screen.queryByRole('button', { name: 'Close sidebar' })).not.toBeInTheDocument()
      expect(screen.queryByRole('link', { name: 'Squirmy home' })).not.toBeInTheDocument()
      await userEvent.click(screen.getByRole('button', { name: 'Open sidebar' }))
      expect(onToggle).toHaveBeenCalledTimes(1)
    })

    it('keeps the navigation links mounted so their labels can fade across a toggle', async () => {
      renderSidebar({ toggles: true })
      const search = mainNav().getByRole('link', { name: 'Search' })
      await userEvent.click(screen.getByRole('button', { name: 'Close sidebar' }))
      expect(mainNav().getByRole('link', { name: 'Search' })).toBe(search)
      await userEvent.click(screen.getByRole('button', { name: 'Open sidebar' }))
      expect(mainNav().getByRole('link', { name: 'Search' })).toBe(search)
    })

    it('keeps the keyboard on the toggle as it folds and opens, though each state has its own button', async () => {
      renderSidebar({ toggles: true })
      screen.getByRole('button', { name: 'Close sidebar' }).focus()
      await userEvent.keyboard('{Enter}')
      expect(screen.getByRole('button', { name: 'Open sidebar' })).toHaveFocus()
      const focus = vi.spyOn(HTMLButtonElement.prototype, 'focus')
      try {
        await userEvent.keyboard('{Enter}')
        const close = screen.getByRole('button', { name: 'Close sidebar' })
        expect(close).toHaveFocus()
        expect(focus).toHaveBeenCalledWith({ preventScroll: true })
      } finally {
        focus.mockRestore()
      }
    })

    it('folds from Close sidebar while open', async () => {
      const { onToggle } = renderSidebar()
      expect(screen.queryByRole('button', { name: 'Open sidebar' })).not.toBeInTheDocument()
      expect(screen.getByRole('list', { name: 'Playlists' }).closest('[inert]')).toBeNull()
      await userEvent.click(screen.getByRole('button', { name: 'Close sidebar' }))
      expect(onToggle).toHaveBeenCalledTimes(1)
    })
  })

  describe('as a drawer on a phone', () => {
    it('is out of reach while closed', () => {
      renderSidebar({ mobile: true, mobileOpen: false })
      expect(screen.queryByRole('complementary', { name: 'Sidebar' })).not.toBeInTheDocument()
      expect(screen.queryByRole('link', { name: 'Library' })).not.toBeInTheDocument()
      expect(screen.getByLabelText('Sidebar')).toHaveAttribute('inert')
    })

    it('shows everything while open, playlists included', () => {
      renderSidebar({ mobile: true, mobileOpen: true })
      expect(sidebar()).not.toHaveAttribute('inert')
      expect(mainNav().getByRole('link', { name: 'Library' })).toBeInTheDocument()
      expect(playlistLinks()).toHaveLength(playlists.length + 1)
      expect(screen.getByRole('button', { name: 'Account, Alex Rivera' })).toBeInTheDocument()
    })

    it('closes from its Close sidebar button', async () => {
      const { onToggle } = renderSidebar({ mobile: true, mobileOpen: true })
      await userEvent.click(screen.getByRole('button', { name: 'Close sidebar' }))
      expect(onToggle).toHaveBeenCalledTimes(1)
    })
  })
})
