import { act, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ApiError } from '@squirmy/client-core'
import { describe, expect, it, vi } from 'vitest'
import { AppRoutes } from '@/App'
import { album, allTracks } from '@/fixtures/catalog'
import { fakeServices } from '@/test/fake-services'
import { renderWithApp } from '@/test/render'

const blueHour = album('blue-hour')
const availability = (trackId: string) => allTracks.find(track => track.id === trackId)?.availability

describe('PlayerProvider', () => {
  it('says on the player that a radio is starting, and why one did not, with no second request meanwhile', async () => {
    const { services, api } = fakeServices()
    let fail: (error: Error) => void = () => {}
    const track = vi.fn(() => new Promise<never>((_resolve, reject) => { fail = reject }))
    Object.assign(api, { radio: { track, artist: vi.fn() } })
    renderWithApp(<AppRoutes />, `/album/${blueHour.id}`, services)
    const song = blueHour.discs[0].tracks[0]
    for (let i = 0; i < 2; i++) {
      await userEvent.click(await screen.findByRole('button', { name: `More options for ${song.title}` }))
      await userEvent.click(await screen.findByRole('menuitem', { name: 'Start radio' }))
    }
    const player = screen.getByRole('region', { name: 'Player' })
    expect(await within(player).findByText('Starting radio…')).toBeInTheDocument()
    expect(track).toHaveBeenCalledOnce()
    act(() => fail(new Error('Boom')))
    expect(await within(player).findByText('Couldn’t start a radio from this song. Try again.')).toBeInTheDocument()
    expect(within(player).queryByText('Starting radio…')).toBeNull()
  })

  it('plays an album through the session, never sending what cannot play', async () => {
    const { services, socket } = fakeServices()
    renderWithApp(<AppRoutes />, `/album/${blueHour.id}`, services)
    await userEvent.click(await screen.findByRole('button', { name: 'Play Blue Hour' }))

    await waitFor(() => expect(socket.session.current).not.toBeNull())
    const { current, queue, context } = socket.session
    const entries = [current!, ...queue]
    expect(entries.map(entry => availability(entry.trackId))).not.toContain('none')
    expect(entries.find(entry => availability(entry.trackId) === 'on_demand')?.state).toBe('preparing')
    expect(entries).toHaveLength(blueHour.discs.flatMap(disc => disc.tracks).filter(track => track.availability !== 'none').length)
    expect(context).toEqual({ type: 'album', id: blueHour.id, title: 'Blue Hour' })
    expect(socket.session.activeDeviceId).not.toBeNull()
    expect(document.title).toBe('Night Swimming · Mira Vale')
  })

  it('shows the queue hydrated from track summaries, and edits it', async () => {
    const { services, socket } = fakeServices()
    renderWithApp(<AppRoutes />, `/album/${blueHour.id}`, services)
    await userEvent.click(await screen.findByRole('button', { name: 'Play Blue Hour' }))
    await userEvent.click(screen.getByRole('button', { name: 'Queue' }))

    const panel = await screen.findByRole('complementary', { name: 'Queue' })
    expect(await within(panel).findByRole('button', { name: 'Reorder Soft Signal, position 1 of 5' })).toBeInTheDocument()
    await userEvent.click(within(panel).getByRole('button', { name: 'Remove Soft Signal from queue' }))
    await waitFor(() => expect(socket.session.queue.map(entry => entry.trackId)).not.toContain(blueHour.discs[0].tracks[1].id))
    expect(within(panel).queryByRole('button', { name: /Reorder Soft Signal/ })).toBeNull()
  })

  it('changes the playing track’s heart at once and tells the server', async () => {
    const { services, api } = fakeServices()
    const first = blueHour.discs[0].tracks[0]
    expect(first.liked).toBe(true)
    renderWithApp(<AppRoutes />, `/album/${blueHour.id}`, services)
    await userEvent.click(await screen.findByRole('button', { name: 'Play Blue Hour' }))
    const player = await screen.findByRole('region', { name: 'Player' })
    await userEvent.click(await within(player).findByRole('button', { name: `Remove ${first.title} from library` }))
    expect(api.userdata.unlike).toHaveBeenCalledWith('track', first.id)
    expect(await within(player).findByRole('button', { name: `Save ${first.title} to library` })).toBeInTheDocument()
    // The album page shows the same track, from its own cached answer.
    expect(within(screen.getByRole('list', { name: 'Blue Hour tracks' })).getByRole('button', { name: `Save ${first.title} to library` })).toBeInTheDocument()
  })

  it('asks before clearing the history, then clears it at once and says so on the status line', async () => {
    const { services, socket } = fakeServices()
    renderWithApp(<AppRoutes />, `/album/${blueHour.id}`, services)
    await userEvent.click(await screen.findByRole('button', { name: 'Play Blue Hour' }))
    await userEvent.click(screen.getAllByRole('button', { name: 'Next' })[0]!)
    await waitFor(() => expect(socket.session.history).toHaveLength(1))
    await userEvent.click(screen.getByRole('button', { name: 'Queue' }))
    const panel = await screen.findByRole('complementary', { name: 'Queue' })

    // Cancel keeps it.
    await userEvent.click(within(panel).getByRole('button', { name: 'Clear history' }))
    const ask = await screen.findByRole('dialog', { name: 'Clear history?' })
    await userEvent.click(within(ask).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Clear history?' })).toBeNull())
    expect(socket.session.history).toHaveLength(1)

    await userEvent.click(within(panel).getByRole('button', { name: 'Clear history' }))
    await userEvent.click(within(await screen.findByRole('dialog', { name: 'Clear history?' })).getByRole('button', { name: 'Clear history' }))
    await waitFor(() => expect(socket.session.history).toEqual([]))
    expect(within(panel).queryByRole('heading', { name: 'History' })).toBeNull()
    const player = screen.getByRole('region', { name: 'Player' })
    expect(within(player).getByText('History cleared')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull()
  })

  it('says what a command from elsewhere told it on the status line, under the song', async () => {
    const { services, api } = fakeServices()
    renderWithApp(<AppRoutes />, `/album/${blueHour.id}`, services)
    await userEvent.click(await screen.findByRole('button', { name: 'Play Blue Hour' }))
    // A card's Play whose album does not load says so where playback is told.
    api.catalog.album.mockRejectedValue(new ApiError(503, 'unavailable', 'The server is busy.'))
    await userEvent.click(screen.getByRole('link', { name: 'Home' }))
    const card = (await screen.findAllByRole('button', { name: /^Play / })).find(button => button.closest('[class*="group/card"]'))!
    await userEvent.click(card)
    const player = screen.getByRole('region', { name: 'Player' })
    expect(await within(player).findByText(/^Couldn’t play “.+”\. /)).toBeInTheDocument()
    expect(within(player).getByText(/The server is busy\./)).toBeInTheDocument()
  })
})
