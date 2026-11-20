import { fireEvent, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { track } from '@/fixtures/catalog'
import type { QueueItem } from '@/player/player-context'
import { renderWithApp } from '@/test/render'
import { SortableQueue } from './Queue'

const items: QueueItem[] = ['soft-signal', 'amber', 'passing-glass'].map((slug, index) => {
  const item = track(slug)
  return { track: item, entry: { id: `e${index}`, trackId: item.id, albumId: null, durationMs: item.durationMs, state: 'ready' } }
})

function renderQueue() {
  const handlers = { onMove: vi.fn(), onRemove: vi.fn(), onPlay: vi.fn() }
  renderWithApp(<SortableQueue items={items} {...handlers} />)
  return handlers
}

describe('SortableQueue', () => {
  it('moves an entry with the arrow keys on its handle', () => {
    const { onMove } = renderQueue()
    fireEvent.keyDown(screen.getByRole('button', { name: 'Reorder Amber, position 2 of 3' }), { key: 'ArrowDown' })
    expect(onMove).toHaveBeenCalledWith('e1', 2)
    fireEvent.keyDown(screen.getByRole('button', { name: 'Reorder Amber, position 2 of 3' }), { key: 'ArrowUp' })
    expect(onMove).toHaveBeenLastCalledWith('e1', 0)
    expect(screen.getByText('Amber moved to position 1 of 3')).toBeInTheDocument()
  })

  it('does not move past either end', () => {
    const { onMove } = renderQueue()
    fireEvent.keyDown(screen.getByRole('button', { name: /Reorder Soft Signal/ }), { key: 'ArrowUp' })
    fireEvent.keyDown(screen.getByRole('button', { name: /Reorder Passing Glass/ }), { key: 'ArrowDown' })
    expect(onMove).not.toHaveBeenCalled()
  })

  it('drops a dragged entry where the pointer lets go', () => {
    const { onMove } = renderQueue()
    const handle = screen.getByRole('button', { name: /Reorder Soft Signal/ })
    fireEvent.pointerDown(handle, { button: 0, clientY: 100, pointerId: 1 })
    fireEvent.pointerMove(handle, { clientY: 100 + 56 * 2, pointerId: 1 })
    fireEvent.pointerUp(handle, { pointerId: 1 })
    expect(onMove).toHaveBeenCalledWith('e0', 2)
  })

  it('removes and plays entries', async () => {
    const { onRemove, onPlay } = renderQueue()
    await userEvent.click(screen.getByRole('button', { name: 'Remove Amber from queue' }))
    await userEvent.click(screen.getByRole('button', { name: 'Play Passing Glass' }))
    expect(onRemove).toHaveBeenCalledWith('e1')
    expect(onPlay).toHaveBeenCalledWith('e2')
  })
})
