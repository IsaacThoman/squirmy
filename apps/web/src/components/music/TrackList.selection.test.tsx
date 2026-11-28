import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { errorMessage } from '@/api/errors'
import { track } from '@/fixtures/catalog'
import { dataTransfer } from '@/test/data-transfer'
import { renderWithApp } from '@/test/render'
import { endTrackDrag } from '@/lib/drag'
import { TrackList, VirtualTrackList } from './TrackList'
import type { TrackBatch } from './track-selection'

const songs = ['soft-signal', 'amber', 'passing-glass', 'riverside'].map(track)

function renderList({ remove, virtual = false }: { remove?: string; virtual?: boolean } = {}) {
  const act = vi.fn<TrackBatch['act']>()
  const batch: TrackBatch = { act, playlists: [{ id: 'p1', name: 'After Dark' }], remove }
  const List = virtual ? VirtualTrackList : TrackList
  renderWithApp(
    <>
      <List label="Songs" tracks={songs} variant="playlist" onPlay={vi.fn()} onAction={vi.fn()} batch={batch} />
      <button type="button">Elsewhere</button>
    </>,
  )
  return { act }
}

const rows = () => within(screen.getByRole('list', { name: 'Songs' })).getAllByRole('listitem')
/** The rows picked now, by title. */
const picked = () => rows().filter(row => row.hasAttribute('data-selected')).map(row => row.querySelector('[title]')?.getAttribute('title'))
/** A click on the row itself, not on one of its controls. */
const clickRow = (index: number, modifiers: { ctrlKey?: boolean; shiftKey?: boolean } = {}) => fireEvent.click(rows()[index].querySelector('.grid')!, modifiers)

describe('TrackList selection', () => {
  it('picks a row with a click, adds one with Ctrl-click and a range with Shift-click', () => {
    renderList()
    clickRow(1)
    expect(picked()).toEqual(['Amber'])
    clickRow(3, { ctrlKey: true })
    expect(picked()).toEqual(['Amber', 'Riverside'])
    clickRow(0, { shiftKey: true })
    expect(picked()).toEqual(['Soft Signal', 'Amber', 'Passing Glass', 'Riverside'])
    clickRow(2)
    expect(picked()).toEqual(['Passing Glass'])
  })

  it('leaves a click on a row’s play button, links and heart to them', async () => {
    renderList()
    await userEvent.click(screen.getByRole('button', { name: 'Play Amber' }))
    expect(picked()).toEqual([])
  })

  it('picks every row with Ctrl+A and lets go with Escape', async () => {
    renderList()
    clickRow(0)
    screen.getByRole('button', { name: 'Play Soft Signal' }).focus()
    await userEvent.keyboard('{Control>}a{/Control}')
    expect(picked()).toHaveLength(4)
    expect(screen.getByRole('toolbar', { name: 'Selected songs' })).toHaveTextContent('4 songs selected')
    await userEvent.keyboard('{Escape}')
    expect(picked()).toEqual([])
    expect(screen.queryByRole('toolbar', { name: 'Selected songs' })).toBeNull()
  })

  it('moves between rows with the arrow keys and grows a range with Shift', async () => {
    renderList()
    screen.getByRole('button', { name: 'Play Soft Signal' }).focus()
    await userEvent.keyboard('{ArrowDown}')
    expect(screen.getByRole('button', { name: 'Play Amber' })).toHaveFocus()
    await userEvent.keyboard('{Shift>}{ArrowDown}{ArrowDown}{/Shift}')
    expect(picked()).toEqual(['Amber', 'Passing Glass', 'Riverside'])
    expect(screen.getByRole('button', { name: 'Play Riverside' })).toHaveFocus()
    await userEvent.keyboard('{Shift>}{ArrowUp}{/Shift}')
    expect(picked()).toEqual(['Amber', 'Passing Glass'])
  })

  it('lets go when the page is pressed elsewhere', () => {
    renderList()
    clickRow(1)
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Elsewhere' }))
    expect(picked()).toEqual([])
  })

  it('acts on the picked rows from the bar, in the list’s order, and says what it did on the button', async () => {
    const { act } = renderList()
    clickRow(2)
    clickRow(0, { ctrlKey: true })
    const bar = screen.getByRole('toolbar', { name: 'Selected songs' })
    expect(bar).toHaveTextContent('2 songs selected')
    await userEvent.click(within(bar).getByRole('button', { name: 'Play' }))
    expect(act).toHaveBeenLastCalledWith('play', [0, 2])
    await userEvent.click(within(bar).getByRole('button', { name: 'Add to queue' }))
    expect(act).toHaveBeenLastCalledWith('enqueue', [0, 2])
    expect(within(bar).getByText('Added to queue', { selector: '[role="status"]' })).toBeInTheDocument()
    await userEvent.click(within(bar).getByRole('button', { name: 'Add to playlist' }))
    await userEvent.click(await screen.findByRole('menuitem', { name: 'After Dark' }))
    expect(act).toHaveBeenLastCalledWith('add-to:p1', [0, 2])
  })

  it('says a refusal in the bar', async () => {
    const { act } = renderList()
    act.mockRejectedValue(new Error('The server said no'))
    clickRow(1)
    await userEvent.click(within(screen.getByRole('toolbar', { name: 'Selected songs' })).getByRole('button', { name: /library/ }))
    expect(await within(screen.getByRole('toolbar', { name: 'Selected songs' })).findByText(errorMessage(new Error('The server said no')))).toBeInTheDocument()
  })

  it('opens the picked songs’ menu from a right-click on one of them, with Remove where the list allows it', async () => {
    const { act } = renderList({ remove: 'playlist' })
    clickRow(0)
    clickRow(1, { shiftKey: true })
    fireEvent.contextMenu(rows()[1], { clientX: 10, clientY: 10 })
    const menu = await screen.findByRole('menu')
    expect(within(menu).getByText('2 songs selected')).toBeInTheDocument()
    await userEvent.click(within(menu).getByRole('menuitem', { name: 'Remove from playlist' }))
    expect(act).toHaveBeenCalledWith('remove', [0, 1])
  })

  it('opens a song’s own menu from a right-click on a row that is not picked', async () => {
    renderList()
    clickRow(0)
    clickRow(1, { ctrlKey: true })
    fireEvent.contextMenu(rows()[3], { clientX: 10, clientY: 10 })
    expect(await screen.findByRole('menuitem', { name: 'Start radio' })).toBeInTheDocument()
  })

  it('drags every picked song together, and one that is not picked alone', () => {
    renderList()
    clickRow(0)
    clickRow(2, { ctrlKey: true })
    const transfer = dataTransfer()
    fireEvent.dragStart(rows()[2], { dataTransfer: transfer })
    expect(transfer.getData('application/x-squirmy-tracks')).toBe([songs[0].id, songs[2].id].join(','))
    endTrackDrag()
    const alone = dataTransfer()
    fireEvent.dragStart(rows()[3], { dataTransfer: alone })
    expect(alone.getData('application/x-squirmy-tracks')).toBe(songs[3].id)
    endTrackDrag()
  })

  it('works the same in a virtual list, by key rather than by row', async () => {
    const { act } = renderList({ virtual: true })
    clickRow(0)
    clickRow(3, { shiftKey: true })
    expect(picked()).toHaveLength(4)
    await userEvent.click(within(screen.getByRole('toolbar', { name: 'Selected songs' })).getByRole('button', { name: 'Play next' }))
    await waitFor(() => expect(act).toHaveBeenCalledWith('play-next', [0, 1, 2, 3]))
  })
})
