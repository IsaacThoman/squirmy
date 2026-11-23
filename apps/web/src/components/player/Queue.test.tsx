import { fireEvent, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { track } from '@/fixtures/catalog'
import type { QueueItem } from '@/player/player-context'
import { renderWithApp } from '@/test/render'
import type { Player, PlayerControls, PlayerState } from '@/player/player-context'
import { QueueContent, SortableQueue } from './Queue'

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

  it('has the heart on every song, saved or not', () => {
    const mixed = items.map((item, index) => ({ ...item, track: { ...item.track, liked: index === 0 } }))
    renderWithApp(<SortableQueue items={mixed} onMove={vi.fn()} onRemove={vi.fn()} onPlay={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'Remove Soft Signal from library' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save Amber to library' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save Passing Glass to library' })).toBeInTheDocument()
  })

  it('removes and plays entries', async () => {
    const { onRemove, onPlay } = renderQueue()
    await userEvent.click(screen.getByRole('button', { name: 'Remove Amber from queue' }))
    await userEvent.click(screen.getByRole('button', { name: 'Play Passing Glass' }))
    expect(onRemove).toHaveBeenCalledWith('e1')
    expect(onPlay).toHaveBeenCalledWith('e2')
  })

  it('shows upcoming songs that wait to be fetched like any other', () => {
    const waiting = items.map(item => ({ ...item, track: { ...item.track, availability: 'on_demand' as const }, entry: { ...item.entry, state: 'preparing' as const } }))
    renderWithApp(<SortableQueue items={waiting} onMove={vi.fn()} onRemove={vi.fn()} onPlay={vi.fn()} />)
    expect(screen.queryByRole('status')).toBeNull()
    expect(screen.queryByText(/preparing|on demand/i)).toBeNull()
    expect(screen.getByRole('button', { name: 'Play Amber' })).toHaveTextContent('Amber')
  })

  it('grays out a song that could not be had and says “Not available”', () => {
    const failed = items.map((item, index) => (index === 1 ? { ...item, entry: { ...item.entry, state: 'failed' as const } } : item))
    renderWithApp(<SortableQueue items={failed} onMove={vi.fn()} onRemove={vi.fn()} onPlay={vi.fn()} />)
    expect(screen.queryByRole('button', { name: 'Play Amber' })).toBeNull()
    expect(screen.getByText('Not available')).toBeInTheDocument()
    expect(screen.getByText('Amber')).toHaveClass('text-muted-foreground')
  })
})

describe('QueueContent', () => {
  it('fades the artwork of history rows, never their words', () => {
    const state = { current: null, playing: false, waiting: false, queue: [], history: items, autoplayQueue: [], autoplay: false, shuffle: false, repeat: 'off' } as unknown as PlayerState
    const player = { state, controls: new Proxy({}, { get: () => vi.fn() }) as PlayerControls } satisfies Player
    renderWithApp(<QueueContent player={player} />)
    const title = screen.getByText('Amber')
    for (let node: HTMLElement | null = title; node; node = node.parentElement) expect(node.className).not.toMatch(/(^|\s)opacity-/)
  })
})
