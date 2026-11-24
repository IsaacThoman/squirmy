import { ApiError } from '@squirmy/client-core'
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { renderWithApp } from '@/test/render'
import { Button } from './button'
import { ContextMenu, DropdownMenu, type MenuEntry } from './menu'

/** A promise and the functions that settle it. */
function deferred() {
  let resolve!: (value?: unknown) => void
  let reject!: (error: unknown) => void
  const promise = new Promise((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

const open = async () => userEvent.click(screen.getByRole('button', { name: 'Song' }))
const menu = (entries: MenuEntry[]) => renderWithApp(<DropdownMenu entries={entries} trigger={<Button>Song</Button>} />)

describe('menu items', () => {
  it('close the menu as they run, when they have nothing to say', async () => {
    const onSelect = vi.fn()
    menu([{ label: 'Go to album', onSelect }])
    await open()
    await userEvent.click(screen.getByRole('menuitem', { name: 'Go to album' }))
    expect(onSelect).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('say in place what worked when nothing else shows it, read out, then close', async () => {
    const onSelect = vi.fn()
    menu([{ label: 'Add to queue', onSelect, done: 'Added to queue' }])
    await open()
    await userEvent.click(screen.getByRole('menuitem', { name: 'Add to queue' }))
    expect(screen.getByRole('menuitem', { name: 'Added to queue' })).toBeInTheDocument()
    expect(within(screen.getByRole('menu')).getByRole('status')).toHaveTextContent('Added to queue')
    // Pressed again while it says so: once is enough.
    await userEvent.click(screen.getByRole('menuitem', { name: 'Added to queue' }))
    expect(onSelect).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
  })

  it('wait for an action that answers later, and say on the item why it did not work', async () => {
    const answer = deferred()
    const onSelect = vi.fn(() => answer.promise)
    menu([{ label: 'Night Drive', onSelect, done: 'Added to Night Drive' }])
    await open()
    await userEvent.click(screen.getByRole('menuitem', { name: 'Night Drive' }))
    const item = screen.getByRole('menuitem', { name: 'Night Drive' })
    expect(item).toHaveAttribute('aria-busy', 'true')
    answer.reject(new ApiError(503, 'unavailable', 'The server is busy.'))
    await waitFor(() => expect(item).toHaveTextContent('The server is busy.'))
    expect(item).toHaveAttribute('data-feedback', 'failed')
    expect(within(screen.getByRole('menu')).getByRole('status')).toHaveTextContent('The server is busy.')

    // It stays open, and can be pressed again.
    const again = deferred()
    onSelect.mockImplementationOnce(() => again.promise)
    await userEvent.click(item)
    expect(onSelect).toHaveBeenCalledTimes(2)
    again.resolve()
    expect(await screen.findByRole('menuitem', { name: 'Added to Night Drive' })).toBeInTheDocument()
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
  })

  it('close at once for an action that went on elsewhere (a dialog asks)', async () => {
    menu([{ label: 'Night Drive', onSelect: async () => false, done: 'Added to Night Drive' }])
    await open()
    await userEvent.click(screen.getByRole('menuitem', { name: 'Night Drive' }))
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
    expect(screen.queryByText('Added to Night Drive')).toBeNull()
  })

  it('start afresh when the menu opens again', async () => {
    menu([{ label: 'Night Drive', onSelect: () => Promise.reject(new ApiError(503, 'unavailable', 'The server is busy.')) }])
    await open()
    await userEvent.click(screen.getByRole('menuitem', { name: 'Night Drive' }))
    await waitFor(() => expect(screen.getByRole('menuitem', { name: /Night Drive/ })).toHaveAttribute('data-feedback', 'failed'))
    await userEvent.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
    await open()
    expect(screen.queryByText('The server is busy.')).toBeNull()
  })

  it('say what worked in a right-click menu too, then close it', async () => {
    renderWithApp(<ContextMenu entries={[{ label: 'Play next', onSelect: () => {}, done: 'Playing next' }]}><div>Row</div></ContextMenu>)
    fireEvent.contextMenu(screen.getByText('Row'))
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Play next' }))
    expect(screen.getByRole('menuitem', { name: 'Playing next' })).toBeInTheDocument()
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
  })
})

/**
 * A pointer event of `pointerType` at a point. jsdom's carry no `pointerType`, so it is set by
 * hand; `cancelable`, so a handler can prevent what follows, as a browser's can.
 */
function pointer(type: string, pointerType: 'mouse' | 'touch' | 'pen', x = 20, y = 20) {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y })
  Object.defineProperty(event, 'pointerType', { value: pointerType })
  return event
}

describe('a dropdown menu’s button', () => {
  const entries: MenuEntry[] = [{ label: 'Go to album', onSelect: () => {} }, { label: 'Add to queue', onSelect: () => {} }]
  const button = () => screen.getByRole('button', { name: 'Song' })

  it('does not open for a finger that goes down on it to scroll the page or a rail', () => {
    menu(entries)
    // The browser takes the gesture to scroll: it cancels the pointer and sends no click.
    fireEvent(button(), pointer('pointerdown', 'touch'))
    expect(screen.queryByRole('menu')).toBeNull()
    fireEvent(button(), pointer('pointercancel', 'touch', 20, 140))
    expect(screen.queryByRole('menu')).toBeNull()
    // A later keyboard click (which a press of Enter on a button also sends) is not that tap.
    fireEvent.click(button())
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('does not open for a finger that moved further than a tap before lifting', () => {
    menu(entries)
    fireEvent(button(), pointer('pointerdown', 'touch', 20, 20))
    fireEvent(button(), pointer('click', 'touch', 20, 60))
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('opens on a tap, a finger or a pen that lifts where it went down', async () => {
    menu(entries)
    fireEvent(button(), pointer('pointerdown', 'touch', 20, 20))
    expect(screen.queryByRole('menu')).toBeNull()
    fireEvent(button(), pointer('click', 'touch', 23, 22))
    expect(await screen.findByRole('menu')).toBeInTheDocument()
    await userEvent.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
    fireEvent(button(), pointer('pointerdown', 'pen'))
    fireEvent(button(), pointer('click', 'pen'))
    expect(await screen.findByRole('menu')).toBeInTheDocument()
  })

  it('opens as a mouse button goes down, as before', async () => {
    menu(entries)
    fireEvent(button(), pointer('pointerdown', 'mouse'))
    expect(await screen.findByRole('menu')).toBeInTheDocument()
  })

  it('opens from the keyboard with focus on its first item', async () => {
    menu(entries)
    button().focus()
    await userEvent.keyboard('{Enter}')
    const opened = await screen.findByRole('menu')
    await waitFor(() => expect(within(opened).getByRole('menuitem', { name: 'Go to album' })).toHaveFocus())
    await userEvent.keyboard('{Escape}')
    await waitFor(() => expect(button()).toHaveFocus())
    await userEvent.keyboard(' ')
    expect(await screen.findByRole('menu')).toBeInTheDocument()
  })

  it('leaves a row’s right-click and long-press menu as it was', async () => {
    vi.useFakeTimers()
    try {
      renderWithApp(<ContextMenu entries={entries}><div>Row</div></ContextMenu>)
      fireEvent(screen.getByText('Row'), pointer('pointerdown', 'touch'))
      // Radix opens a context menu after 700 ms of a finger held still.
      act(() => { vi.advanceTimersByTime(800) })
      expect(screen.getByRole('menu')).toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })
})
