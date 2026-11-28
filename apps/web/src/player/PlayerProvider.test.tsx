import { act, createEvent, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ApiError } from '@squirmy/client-core'
import { UNDO_LIMIT } from '@squirmy/contracts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AppRoutes } from '@/App'
import { album, allTracks, track } from '@/fixtures/catalog'
import { endTrackDrag, startTrackDrag } from '@/lib/drag'
import { dataTransfer } from '@/test/data-transfer'
import { fakeServices } from '@/test/fake-services'
import { renderWithApp } from '@/test/render'

const blueHour = album('blue-hour')
const availability = (trackId: string) => allTracks.find(track => track.id === trackId)?.availability

/** Plays the album on the page as a whole, from its ⋯ menu. */
async function playAlbum() {
  await userEvent.click(await screen.findByRole('button', { name: 'More options' }))
  await userEvent.click(await screen.findByRole('menuitem', { name: 'Play' }))
}

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

  it('starts a radio of songs that sound like a song', async () => {
    const { services, api } = fakeServices()
    const sonic = vi.fn(() => new Promise<never>(() => {}))
    Object.assign(api, { radio: { track: vi.fn(), artist: vi.fn(), sonic } })
    renderWithApp(<AppRoutes />, `/album/${blueHour.id}`, services)
    const song = blueHour.discs[0].tracks[0]
    await userEvent.click(await screen.findByRole('button', { name: `More options for ${song.title}` }))
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Songs that sound like this' }))
    expect(await within(screen.getByRole('region', { name: 'Player' })).findByText('Starting radio…')).toBeInTheDocument()
    expect(sonic).toHaveBeenCalledWith(song.id)
  })

  it('plays an album through the session, never sending what cannot play', async () => {
    const { services, socket } = fakeServices()
    renderWithApp(<AppRoutes />, `/album/${blueHour.id}`, services)
    await playAlbum()

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
    await playAlbum()
    await userEvent.click(screen.getByRole('button', { name: 'Queue' }))

    const panel = await screen.findByRole('complementary', { name: 'Queue' })
    const next = within(panel).getByRole('region', { name: 'Continue Playing' })
    expect(await within(next).findByRole('button', { name: 'Play Soft Signal' })).toBeInTheDocument()
    await userEvent.click(within(panel).getByRole('button', { name: 'Remove Soft Signal from queue' }))
    await waitFor(() => expect(socket.session.queue.map(entry => entry.trackId)).not.toContain(blueHour.discs[0].tracks[1].id))
    expect(within(next).queryByRole('button', { name: 'Play Soft Signal' })).toBeNull()
  })

  it('offers Undo on the status line after a queue edit, and the server puts it back', async () => {
    const { services, socket } = fakeServices()
    renderWithApp(<AppRoutes />, `/album/${blueHour.id}`, services)
    await playAlbum()
    await userEvent.click(screen.getByRole('button', { name: 'Queue' }))
    const panel = await screen.findByRole('complementary', { name: 'Queue' })
    await waitFor(() => expect(within(panel).getByRole('button', { name: 'Remove Soft Signal from queue' })).toBeInTheDocument())
    const queued = socket.session.queue.map(entry => entry.id)
    await userEvent.click(within(panel).getByRole('button', { name: 'Remove Soft Signal from queue' }))

    const player = screen.getByRole('region', { name: 'Player' })
    expect(await within(player).findByText('Removed “Soft Signal”')).toBeInTheDocument()
    await userEvent.click(within(player).getByRole('button', { name: 'Undo' }))
    await waitFor(() => expect(socket.session.queue.map(entry => entry.id)).toEqual(queued))
    expect(socket.commands.at(-1)).toEqual({ type: 'undo', commandId: expect.any(String) })
    expect(within(player).queryByText('Removed “Soft Signal”')).toBeNull()
    expect(await within(panel).findByRole('button', { name: 'Play Soft Signal' })).toBeInTheDocument()
  })

  it('changes the playing track’s heart at once and tells the server', async () => {
    const { services, api } = fakeServices()
    const first = blueHour.discs[0].tracks[0]
    expect(first.liked).toBe(true)
    renderWithApp(<AppRoutes />, `/album/${blueHour.id}`, services)
    await playAlbum()
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
    await playAlbum()
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
    await playAlbum()
    // A card's Play whose album does not load says so where playback is told.
    api.catalog.album.mockRejectedValue(new ApiError(503, 'unavailable', 'The server is busy.'))
    await userEvent.click(screen.getByRole('link', { name: 'Home' }))
    // Not Blue Hour, which just played: its album is already loaded.
    const card = (await screen.findAllByRole('button', { name: /^Play / })).find(button => button.closest('[class*="group/card"]') && button.getAttribute('aria-label') !== 'Play Blue Hour')!
    await userEvent.click(card)
    const player = screen.getByRole('region', { name: 'Player' })
    expect(await within(player).findByText(/^Couldn’t play “.+”\. /)).toBeInTheDocument()
    expect(within(player).getByText(/The server is busy\./)).toBeInTheDocument()
  })
})

describe('song menus in the queue and Now Playing', () => {
  const [first, second, third] = blueHour.discs[0].tracks

  it('moves a song coming up from its menu instead of queueing it again', async () => {
    const { services, socket } = fakeServices()
    renderWithApp(<AppRoutes />, `/album/${blueHour.id}`, services)
    await playAlbum()
    await userEvent.click(screen.getByRole('button', { name: 'Queue' }))
    const panel = await screen.findByRole('complementary', { name: 'Queue' })
    const next = within(panel).getByRole('region', { name: 'Continue Playing' })

    // The first song coming up is next already: its menu moves it to the end.
    await userEvent.click(await within(next).findByRole('button', { name: `More options for ${second!.title}` }))
    expect(screen.queryByRole('menuitem', { name: 'Play next' })).toBeNull()
    expect(screen.queryByRole('menuitem', { name: 'Add to queue' })).toBeNull()
    await userEvent.click(screen.getByRole('menuitem', { name: 'Move to end' }))
    await waitFor(() => expect(socket.session.queue.at(-1)?.trackId).toBe(second!.id))
    expect(socket.session.queue[0]?.trackId).toBe(third!.id)
    const length = socket.session.queue.length

    // Now last, it comes back to the front with Play next, and is not queued a second time.
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
    await userEvent.click(within(next).getByRole('button', { name: `More options for ${second!.title}` }))
    expect(screen.queryByRole('menuitem', { name: 'Move to end' })).toBeNull()
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Play next' }))
    await waitFor(() => expect(socket.session.queue[0]?.trackId).toBe(second!.id))
    expect(socket.session.queue).toHaveLength(length)
  }, 15_000)

  it('has the playing song’s menu in Now Playing, which closes as it goes to the artist', async () => {
    const { services } = fakeServices()
    renderWithApp(<AppRoutes />, `/album/${blueHour.id}`, services)
    await playAlbum()
    const player = await screen.findByRole('region', { name: 'Player' })
    await userEvent.click(within(player).getByRole('button', { name: 'Now Playing' }))
    const nowPlaying = await screen.findByRole('dialog', { name: 'Now Playing' })
    await userEvent.click(await within(nowPlaying).findByRole('button', { name: `More options for ${first!.title}` }))
    expect(await screen.findByRole('menuitem', { name: 'Start radio' })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: 'Add to playlist' })).toBeInTheDocument()
    await userEvent.click(screen.getByRole('menuitem', { name: 'Go to album' }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Now Playing' })).toBeNull())
  })
})

/** jsdom's drag events carry no pointer position; this gives one. */
const at = (event: Event, clientY: number) => Object.defineProperty(event, 'clientY', { value: clientY })

describe('dragging music to the queue and the player', () => {
  afterEach(endTrackDrag)

  it('puts songs dropped on the queue where the line shows, between the songs under the pointer', async () => {
    const { services, socket } = fakeServices()
    renderWithApp(<AppRoutes />, `/album/${blueHour.id}`, services)
    await playAlbum()
    await userEvent.click(screen.getByRole('button', { name: 'Queue' }))
    const panel = await screen.findByRole('complementary', { name: 'Queue' })
    await waitFor(() => expect(socket.session.queue.length).toBeGreaterThan(2))
    const before = socket.session.queue.map(entry => entry.trackId)
    const amber = track('amber')
    const transfer = dataTransfer()
    startTrackDrag({ dataTransfer: transfer }, { tracks: [amber], list: null, index: 0 })
    // jsdom lays nothing out: the songs start at 0, so 60 px down is after the first one.
    const target = within(panel).getByRole('region', { name: 'Continue Playing' })
    expect(fireEvent(target, at(createEvent.dragOver(target, { dataTransfer: transfer }), 60))).toBe(false)
    fireEvent(target, at(createEvent.drop(target, { dataTransfer: transfer }), 60))
    await waitFor(() => expect(socket.session.queue.map(entry => entry.trackId)).toEqual([before[0], amber.id, ...before.slice(1)]))

    // One Undo takes the drop back, moves and all.
    const player = screen.getByRole('region', { name: 'Player' })
    expect(within(player).getByText(`Added “${amber.title}” to the queue`)).toBeInTheDocument()
    await userEvent.click(within(player).getByRole('button', { name: 'Undo' }))
    await waitFor(() => expect(socket.session.queue.map(entry => entry.trackId)).toEqual(before))
    expect(socket.commands.filter(command => command.type === 'undo')).toHaveLength(1)
  })

  it('takes a drop of many songs back with Undo when its moves have pushed it off the server\'s stack', async () => {
    const { services, socket } = fakeServices()
    renderWithApp(<AppRoutes />, `/album/${blueHour.id}`, services)
    await playAlbum()
    await userEvent.click(screen.getByRole('button', { name: 'Queue' }))
    const panel = await screen.findByRole('complementary', { name: 'Queue' })
    await waitFor(() => expect(socket.session.queue.length).toBeGreaterThan(2))
    const before = socket.session.queue.map(entry => entry.trackId)
    const playable = allTracks.filter(song => song.availability === 'server')
    const songs = Array.from({ length: UNDO_LIMIT }, (_, index) => playable[index % playable.length]!)
    const transfer = dataTransfer()
    startTrackDrag({ dataTransfer: transfer }, { tracks: songs, list: null, index: 0 })
    const target = within(panel).getByRole('region', { name: 'Continue Playing' })
    fireEvent(target, at(createEvent.dragOver(target, { dataTransfer: transfer }), 60))
    fireEvent(target, at(createEvent.drop(target, { dataTransfer: transfer }), 60))
    await waitFor(() => expect(socket.session.queue).toHaveLength(before.length + UNDO_LIMIT))

    const player = screen.getByRole('region', { name: 'Player' })
    await userEvent.click(within(player).getByRole('button', { name: 'Undo' }))
    await waitFor(() => expect(socket.session.queue.map(entry => entry.trackId)).toEqual(before))
    expect(socket.commands.some(command => command.type === 'undo')).toBe(false)
  })

  it('picks songs in Up next with Ctrl-click and takes them out from the bar', async () => {
    const { services, socket } = fakeServices()
    renderWithApp(<AppRoutes />, `/album/${blueHour.id}`, services)
    await playAlbum()
    await userEvent.click(screen.getByRole('button', { name: 'Queue' }))
    const panel = await screen.findByRole('complementary', { name: 'Queue' })
    const next = within(panel).getByRole('region', { name: 'Continue Playing' })
    const [first, second] = blueHour.discs[0].tracks.slice(1)
    fireEvent.click(await within(next).findByRole('button', { name: `Play ${first.title}` }), { ctrlKey: true })
    fireEvent.click(within(next).getByRole('button', { name: `Play ${second.title}` }), { ctrlKey: true })
    // Picked, not played.
    expect(socket.session.queue[0]?.trackId).toBe(first.id)
    const bar = within(panel).getByRole('toolbar', { name: 'Selected songs' })
    expect(bar).toHaveTextContent('2 songs')
    await userEvent.click(within(bar).getByRole('button', { name: 'Remove from queue' }))
    await waitFor(() => expect(socket.session.queue.map(entry => entry.trackId)).not.toContain(second.id))
    expect(socket.session.queue.map(entry => entry.trackId)).not.toContain(first.id)
  })

  it('plays next what is dropped on the player, and says so there', async () => {
    const { services, socket } = fakeServices()
    renderWithApp(<AppRoutes />, `/album/${blueHour.id}`, services)
    await playAlbum()
    await waitFor(() => expect(socket.session.current).not.toBeNull())
    const songs = [track('amber'), track('riverside')]
    const transfer = dataTransfer()
    startTrackDrag({ dataTransfer: transfer }, { tracks: songs, list: null, index: 0 })
    const player = screen.getByRole('region', { name: 'Player' })
    fireEvent.dragOver(player, { dataTransfer: transfer })
    expect(within(player).getByText('Drop to play next')).toBeInTheDocument()
    fireEvent.drop(player, { dataTransfer: transfer })
    await waitFor(() => expect(socket.session.queue.slice(0, 2).map(entry => entry.trackId)).toEqual(songs.map(song => song.id)))
    expect(await within(player).findByText(/Playing next/)).toBeInTheDocument()
  })
})

describe('playing a long list', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    localStorage.clear()
  })

  it('plays the songs it loaded when a page of the rest fails, and says so', async () => {
    const { services, api, socket } = fakeServices()
    const liked = allTracks.filter(track => track.liked && track.availability !== 'none')
    api.userdata.likes
      .mockResolvedValueOnce({ items: liked.slice(0, 2), nextCursor: 'more' })
      .mockRejectedValueOnce(new ApiError(400, 'bad_cursor', 'That page is gone.'))
    // From Library's row: the Liked Songs page itself loads more as it scrolls.
    localStorage.setItem('squirmy.library.layout', 'list')
    // jsdom lays nothing out, so the virtual list would show no rows: every box is a screen's size.
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1024)
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(900)
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(220)
    renderWithApp(<AppRoutes />, '/library?filter=all', services)
    const list = await screen.findByRole('list', { name: 'Library' })
    await userEvent.click(await within(list).findByRole('button', { name: 'Play Liked Songs' }))
    const player = screen.getByRole('region', { name: 'Player' })
    expect(await within(player).findByText(/^Couldn’t load the whole list\./)).toBeInTheDocument()
    expect(within(player).getByText(/Playing the songs loaded so far\./)).toBeInTheDocument()
    await waitFor(() => expect([socket.session.current, ...socket.session.queue].filter(Boolean).map(entry => entry!.trackId)).toEqual(liked.slice(0, 2).map(track => track.id)))
  })
})
