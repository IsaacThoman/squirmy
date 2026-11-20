import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { AppRoutes } from '@/App'
import { album, allTracks } from '@/fixtures/catalog'
import { fakeServices } from '@/test/fake-services'
import { renderWithApp } from '@/test/render'

const blueHour = album('blue-hour')
const availability = (trackId: string) => allTracks.find(track => track.id === trackId)?.availability

describe('PlayerProvider', () => {
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

  it('changes the playing track’s like at once and tells the server', async () => {
    const { services, api } = fakeServices()
    const first = blueHour.discs[0].tracks[0]
    expect(first.liked).toBe(true)
    renderWithApp(<AppRoutes />, `/album/${blueHour.id}`, services)
    await userEvent.click(await screen.findByRole('button', { name: 'Play Blue Hour' }))
    const [heart] = await screen.findAllByRole('button', { name: 'Remove from Liked Songs' })
    await userEvent.click(heart)
    expect(api.userdata.unlike).toHaveBeenCalledWith('track', first.id)
    expect((await screen.findAllByRole('button', { name: 'Save to Liked Songs' })).length).toBeGreaterThan(0)
    // The album page shows the same track, from its own cached answer.
    expect(screen.getByRole('button', { name: `Save ${first.title} to Liked Songs` })).toBeInTheDocument()
  })
})
