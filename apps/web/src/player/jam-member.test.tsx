import type { Session } from '@squirmy/client-core'
import type { JamInfo } from '@squirmy/contracts'
import { act, createEvent, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import { AppRoutes } from '@/App'
import { album, track } from '@/fixtures/catalog'
import { currentUser, users } from '@/fixtures/server'
import { endTrackDrag, startTrackDrag } from '@/lib/drag'
import { dataTransfer } from '@/test/data-transfer'
import { fakeServices, type FakeSocket } from '@/test/fake-services'
import { renderWithApp } from '@/test/render'

/**
 * A member of someone's jam, on the web: what the player dims (transport) is refused wherever
 * else it can be asked for, songs go into the queue where the jam's policy lets everyone add,
 * and a member takes out only what they added.
 */

const blueHour = album('blue-hour')
const HOST = users[1]!

function memberOf(queuePolicy: JamInfo['queuePolicy']): JamInfo {
  return {
    id: 'abcdefghijklmnopqrstuv', hostUserId: HOST.id, queuePolicy, startedAt: 0, role: 'member',
    members: [{ userId: HOST.id, name: 'Sam Okafor', joinedAt: 0 }, { userId: currentUser.id, name: 'Alex Kim', joinedAt: 1 }],
  }
}

/** The album playing, then this user following Sam's jam; the first song coming up is this user's, the rest Sam's. */
async function joinJam(queuePolicy: JamInfo['queuePolicy']) {
  const fake = fakeServices()
  renderWithApp(<AppRoutes />, `/album/${blueHour.id}`, fake.services)
  await userEvent.click(await screen.findByRole('button', { name: 'More options' }))
  await userEvent.click(await screen.findByRole('menuitem', { name: 'Play' }))
  await waitFor(() => expect(fake.socket.session.queue.length).toBeGreaterThan(2))
  act(() => fake.socket.serverSet((session: Session) => ({
    ...session,
    jam: memberOf(queuePolicy),
    queue: session.queue.map((entry, index) => ({ ...entry, addedBy: index === 0 ? currentUser.id : HOST.id })),
  })))
  const player = screen.getByRole('region', { name: 'Player' })
  await waitFor(() => expect(within(player).getByRole('button', { name: 'Next' })).toBeDisabled())
  fake.socket.commands.length = 0
  return fake
}

const sent = (socket: FakeSocket) => socket.commands.map(command => command.type)

async function openQueue() {
  await userEvent.click(screen.getByRole('button', { name: 'Queue' }))
  const panel = await screen.findByRole('complementary', { name: 'Queue' })
  return { panel, next: within(panel).getByRole('region', { name: /Continue Playing|Up Next/ }) }
}

/** jsdom's drag events carry no pointer position; this gives one. */
const at = (event: Event, clientY: number) => Object.defineProperty(event, 'clientY', { value: clientY })

describe('a member of someone’s jam', () => {
  afterEach(endTrackDrag)

  it('has no transport keys, as its buttons are dimmed, but keeps the volume', async () => {
    const { socket } = await joinJam('everyone')
    const main = screen.getByRole('main')
    main.focus()
    // The player leaves them be (not prevented), as it does with nothing playing.
    expect(fireEvent.keyDown(main, { key: ' ' })).toBe(true)
    expect(fireEvent.keyDown(main, { key: 'ArrowRight' })).toBe(true)
    expect(fireEvent.keyDown(main, { key: 'ArrowRight', shiftKey: true })).toBe(true)
    expect(fireEvent.keyDown(main, { key: 'ArrowLeft', shiftKey: true })).toBe(true)
    await userEvent.keyboard('s')
    await userEvent.keyboard('r')
    expect(sent(socket)).toEqual([])
    expect(fireEvent.keyDown(main, { key: 'ArrowDown' })).toBe(false)
    await waitFor(() => expect(sent(socket)).toEqual(['setVolume']))
    // The queue's key is the listener's own view.
    await userEvent.keyboard('q')
    expect(await screen.findByRole('complementary', { name: 'Queue' })).toBeInTheDocument()
  })

  it('finds no playback commands in the command palette', async () => {
    await joinJam('everyone')
    await userEvent.keyboard('{Control>}k{/Control}')
    const field = await screen.findByRole('combobox', { name: 'Search' })
    for (const typed of ['Next song', 'Previous song', 'Pause', 'shuffle', 'repeat', 'Clear queue', 'Start radio']) {
      await userEvent.clear(field)
      await userEvent.type(field, typed)
      expect(screen.queryByRole('option', { name: new RegExp(`^${typed}`, 'i') })).toBeNull()
    }
    await userEvent.clear(field)
    await userEvent.type(field, 'Mute')
    expect(await screen.findByRole('option', { name: /^Mute/ })).toBeInTheDocument()
  })

  it('cannot move, play or clear the queue, and its shuffle and repeat are dimmed', async () => {
    const { socket } = await joinJam('everyone')
    const { panel, next } = await openQueue()
    const first = blueHour.discs[0].tracks[1]!
    const row = within(next).getByRole('button', { name: first.title })
    fireEvent.keyDown(row, { key: 'ArrowDown' })
    await userEvent.click(row)
    expect(within(panel).queryByRole('button', { name: 'Clear queue' })).toBeNull()
    expect(within(panel).getByRole('button', { name: /Shuffle/ })).toBeDisabled()
    expect(sent(socket)).toEqual([])
    // Its menu neither moves it nor queues it again.
    await userEvent.click(within(next).getByRole('button', { name: `More options for ${first.title}` }))
    await screen.findByRole('menu')
    expect(screen.queryByRole('menuitem', { name: 'Move to end' })).toBeNull()
    expect(screen.queryByRole('menuitem', { name: 'Play next' })).toBeNull()
    expect(screen.getByRole('menuitem', { name: 'Start radio' })).toHaveAttribute('aria-disabled', 'true')
  })

  it('takes out of the queue only the songs they added, from the row and the selection bar', async () => {
    const { socket } = await joinJam('everyone')
    const { panel, next } = await openQueue()
    const [mine, theirs] = blueHour.discs[0].tracks.slice(1)
    expect(within(next).getByRole('button', { name: `Remove ${mine!.title} from queue` })).toBeInTheDocument()
    expect(within(next).queryByRole('button', { name: `Remove ${theirs!.title} from queue` })).toBeNull()
    fireEvent.click(within(next).getByRole('button', { name: mine!.title }), { ctrlKey: true })
    fireEvent.click(within(next).getByRole('button', { name: theirs!.title }), { ctrlKey: true })
    const bar = within(panel).getByRole('toolbar', { name: 'Selected songs' })
    expect(within(bar).queryByRole('button', { name: 'Move to top' })).toBeNull()
    await userEvent.click(within(bar).getByRole('button', { name: 'Remove the song you added' }))
    await waitFor(() => expect(socket.session.queue.map(entry => entry.trackId)).not.toContain(mine!.id))
    expect(socket.session.queue.map(entry => entry.trackId)).toContain(theirs!.id)
    expect(socket.commands).toEqual([expect.objectContaining({ type: 'removeFromQueue' })])
  })

  it('offers no removal of someone else’s songs picked on their own', async () => {
    await joinJam('everyone')
    const { panel, next } = await openQueue()
    const [, second, third] = blueHour.discs[0].tracks.slice(1)
    fireEvent.click(within(next).getByRole('button', { name: second!.title }), { ctrlKey: true })
    fireEvent.click(within(next).getByRole('button', { name: third!.title }), { ctrlKey: true })
    const bar = within(panel).getByRole('toolbar', { name: 'Selected songs' })
    expect(within(bar).queryByRole('button', { name: /^Remove/ })).toBeNull()
  })

  it('adds dropped songs at the end of the queue for everyone when the jam lets everyone add', async () => {
    const { socket } = await joinJam('everyone')
    const { next } = await openQueue()
    const before = socket.session.queue.map(entry => entry.trackId)
    const amber = track('amber')
    const transfer = dataTransfer()
    startTrackDrag({ dataTransfer: transfer }, { tracks: [amber], list: null, index: 0 })
    // Dropped between the first two songs, it still goes at the end: moving songs is the host's.
    expect(fireEvent(next, at(createEvent.dragOver(next, { dataTransfer: transfer }), 60))).toBe(false)
    fireEvent(next, at(createEvent.drop(next, { dataTransfer: transfer }), 60))
    await waitFor(() => expect(socket.session.queue.map(entry => entry.trackId)).toEqual([...before, amber.id]))
    expect(sent(socket)).toEqual(['enqueue'])
    expect(await within(screen.getByRole('region', { name: 'Player' })).findByText(`Added “${amber.title}” for everyone`)).toBeInTheDocument()
  })

  it('takes no dropped songs, on the queue or the player, when only the host adds them', async () => {
    const { socket } = await joinJam('host')
    const { next } = await openQueue()
    const transfer = dataTransfer()
    startTrackDrag({ dataTransfer: transfer }, { tracks: [track('amber')], list: null, index: 0 })
    // Not prevented: the browser shows the drop is not allowed.
    expect(fireEvent(next, at(createEvent.dragOver(next, { dataTransfer: transfer }), 60))).toBe(true)
    fireEvent(next, at(createEvent.drop(next, { dataTransfer: transfer }), 60))
    const player = screen.getByRole('region', { name: 'Player' })
    expect(fireEvent.dragOver(player, { dataTransfer: transfer })).toBe(true)
    expect(within(player).queryByText('Drop to play next')).toBeNull()
    fireEvent.drop(player, { dataTransfer: transfer })
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(sent(socket)).toEqual([])
  })

  it('is told only the host adds songs when a song’s menu would queue one', async () => {
    const { socket } = await joinJam('host')
    const song = blueHour.discs[0].tracks[0]!
    await userEvent.click(screen.getAllByRole('button', { name: `More options for ${song.title}` })[0]!)
    expect(await screen.findByRole('menuitem', { name: 'Add to queue' })).toHaveAttribute('aria-disabled', 'true')
    expect(screen.getByRole('menuitem', { name: 'Play next' })).toHaveAttribute('aria-disabled', 'true')
    expect(sent(socket)).toEqual([])
  })
})
