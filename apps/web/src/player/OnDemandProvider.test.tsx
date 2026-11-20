import { act, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { AppRoutes } from '@/App'
import { album } from '@/fixtures/catalog'
import { fakeServices } from '@/test/fake-services'
import { renderWithApp } from '@/test/render'

const lowTide = album('low-tide')
const [song, edit] = lowTide.discs[0].tracks
const jobId = '00000000-0000-4000-8b00-000000000001'

describe('OnDemandProvider', () => {
  it('shows the track being fetched as preparing, and tells when its fetch failed', async () => {
    const { services, socket } = fakeServices()
    renderWithApp(<AppRoutes />, `/album/${lowTide.id}`, services)
    // The album's play button comes first; its first song has the same name.
    await userEvent.click((await screen.findAllByRole('button', { name: 'Play Low Tide' }))[0]!)
    await waitFor(() => expect(socket.session.current?.state).toBe('preparing'))

    const tracks = screen.getByRole('list', { name: 'Low Tide tracks' })
    const row = (title: string) => within(tracks).getAllByRole('listitem').find(item => item.textContent?.includes(title))!
    expect(within(row(song.title)).getByText('Preparing…')).toBeInTheDocument()
    // Waiting in the queue is not being fetched yet.
    expect(within(row(edit.title)).queryByText('Preparing…')).toBeNull()

    act(() => socket.serverEmit('event', { type: 'acquisition.updated', jobId, trackId: edit.id, status: 'downloading' }))
    expect(await within(row(edit.title)).findByText('Preparing…')).toBeInTheDocument()

    act(() => socket.serverEmit('event', { type: 'acquisition.updated', jobId, trackId: edit.id, status: 'failed' }))
    expect(await screen.findByText(`Couldn’t get “${edit.title}”`)).toBeInTheDocument()
    expect(within(row(edit.title)).queryByText('Preparing…')).toBeNull()
  })
})
