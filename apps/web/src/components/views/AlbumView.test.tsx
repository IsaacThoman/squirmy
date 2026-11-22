import type { AlbumDetail } from '@squirmy/contracts'
import { act, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { AppRoutes } from '@/App'
import { album } from '@/fixtures/catalog'
import { users } from '@/fixtures/server'
import { fakeServices } from '@/test/fake-services'
import { renderWithApp } from '@/test/render'

const lowTide = album('low-tide')
const blueHour = album('blue-hour')
/** A member who may not have the server fetch music. */
const robin = users[2]!
const machinery = /on demand|library yet|get this album|preparing|not on the server|in your library|fetch/i

describe('album page', () => {
  describe('for someone the server fetches music for', () => {
    it('looks like any album, with nothing about where its music is', async () => {
      renderWithApp(<AppRoutes />, `/album/${lowTide.id}`)
      const tracks = await screen.findByRole('list', { name: 'Low Tide tracks' })
      expect(document.body.textContent).not.toMatch(machinery)
      expect(screen.getAllByRole('button', { name: 'Play Low Tide' })[0]).toBeEnabled()
      expect(within(tracks).getAllByRole('listitem').filter(row => row.getAttribute('aria-disabled'))).toHaveLength(0)
      expect(screen.queryByRole('button', { name: /Wantlist/ })).toBeNull()
    })

    it('plays a song that is not on the server yet after the spinner any song shows while it loads', async () => {
      const { services, socket } = fakeServices()
      renderWithApp(<AppRoutes />, `/album/${lowTide.id}`, services)
      const edit = lowTide.discs[0].tracks[1]
      await userEvent.click(await screen.findByRole('button', { name: `Play ${edit.title}` }))
      await waitFor(() => expect(socket.session.current?.trackId).toBe(edit.id))
      const row = within(screen.getByRole('list', { name: 'Low Tide tracks' })).getAllByRole('listitem')[1]!
      expect(within(row).getByRole('status', { name: 'Loading' })).toBeInTheDocument()
      expect(document.body.textContent).not.toMatch(/preparing/i)
    })

    it('adds the album to the library at once, and takes it out again', async () => {
      const { services, api } = fakeServices()
      renderWithApp(<AppRoutes />, `/album/${lowTide.id}`, services)
      await userEvent.click(await screen.findByRole('button', { name: 'Add to library' }))
      expect(screen.getByRole('button', { name: 'Remove from library' })).toBeInTheDocument()
      expect(api.library.save).toHaveBeenCalledWith('album', lowTide.id)
      await userEvent.click(screen.getByRole('button', { name: 'Remove from library' }))
      expect(await screen.findByRole('button', { name: 'Add to library' })).toBeInTheDocument()
      expect(api.library.remove).toHaveBeenCalledWith('album', lowTide.id)
    })

    it('adds one song to the library from its menu', async () => {
      const { services, api } = fakeServices()
      renderWithApp(<AppRoutes />, `/album/${lowTide.id}`, services)
      const edit = lowTide.discs[0].tracks[1]
      await userEvent.click(await screen.findByRole('button', { name: `More options for ${edit.title}` }))
      await userEvent.click(await screen.findByRole('menuitem', { name: 'Add to library' }))
      expect(api.library.save).toHaveBeenCalledWith('track', edit.id)
      expect(await screen.findByText('Added to your library')).toBeInTheDocument()
    })

    it('shows a check without a remove on music on this server', async () => {
      renderWithApp(<AppRoutes />, `/album/${blueHour.id}`)
      expect(await screen.findByRole('img', { name: 'On this server' })).toBeInTheDocument()
      expect(screen.queryByRole('button', { name: /library/ })).toBeNull()
      await userEvent.click(screen.getByRole('button', { name: 'More options' }))
      expect(screen.queryByRole('menuitem', { name: /library/ })).toBeNull()
    })

    it('can be played before its songs are known, and plays once they arrive', async () => {
      const { services, api, socket } = fakeServices()
      const bare: AlbumDetail = { ...lowTide, discs: [], trackCount: 0, ownedTrackCount: 0, durationMs: 0, detailPending: true }
      api.catalog.album.mockResolvedValueOnce(bare)
      const { queryClient } = renderWithApp(<AppRoutes />, `/album/${lowTide.id}`, services)
      expect(await screen.findByRole('status', { name: 'Loading songs' })).toBeInTheDocument()
      const play = screen.getAllByRole('button', { name: 'Play Low Tide' })[0]!
      await userEvent.click(play)
      expect(play).toHaveAttribute('aria-busy', 'true')
      expect(socket.session.current).toBeNull()
      await act(() => queryClient.invalidateQueries({ queryKey: ['album', lowTide.id] }))
      await waitFor(() => expect(socket.session.current?.trackId).toBe(lowTide.discs[0].tracks[0].id))
    })
  })

  describe('for a member who may not fetch music', () => {
    it('grays out what does not play and says how much does, in one line', async () => {
      renderWithApp(<AppRoutes />, `/album/${blueHour.id}`, fakeServices({ user: robin }).services)
      const tracks = await screen.findByRole('list', { name: 'Blue Hour tracks' })
      expect(screen.getByText(/5 of 7 songs available/)).toBeInTheDocument()
      expect(within(tracks).getAllByRole('listitem').filter(row => row.getAttribute('aria-disabled') === 'true')).toHaveLength(2)
    })

    it('cannot play an album nothing of which plays, and offers it to the Wantlist', async () => {
      renderWithApp(<AppRoutes />, `/album/${lowTide.id}`, fakeServices({ user: robin }).services)
      await screen.findByRole('list', { name: 'Low Tide tracks' })
      expect(screen.getAllByRole('button', { name: 'Play Low Tide' })[0]).toBeDisabled()
      expect(screen.getByRole('button', { name: /Wantlist/ })).toBeInTheDocument()
      expect(document.body.textContent).not.toMatch(machinery)
    })

    it('says nothing of the Wantlist while the server has it off', async () => {
      renderWithApp(<AppRoutes />, `/album/${lowTide.id}`, fakeServices({ user: robin, status: { wantlistEnabled: false } }).services)
      await screen.findByRole('list', { name: 'Low Tide tracks' })
      expect(screen.queryByText(/Wantlist/)).toBeNull()
      expect(screen.queryByRole('button', { name: /Wantlist/ })).toBeNull()
    })
  })

  it('opens Fix match from the menu for admins', async () => {
    renderWithApp(<AppRoutes />, `/album/${blueHour.id}`)
    await userEvent.click(await screen.findByRole('button', { name: 'More options' }))
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Fix match…' }))
    expect(await screen.findByRole('heading', { name: 'Fix match' })).toBeInTheDocument()
  })

  it('has no Fix match for members', async () => {
    renderWithApp(<AppRoutes />, `/album/${blueHour.id}`, fakeServices({ user: users[1] }).services)
    await userEvent.click(await screen.findByRole('button', { name: 'More options' }))
    expect(await screen.findByRole('menuitem', { name: 'Play next' })).toBeInTheDocument()
    expect(screen.queryByRole('menuitem', { name: 'Fix match…' })).toBeNull()
  })
})
